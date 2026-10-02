import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RELEASE_SCHEMA, sha256File, validateReleaseManifest } from './access-stake-contracts.mjs';

const AGAVE_VERSION = 'v4.2.1';
const AGAVE_ARCHIVE_SHA256 = '7f35f92c15861263bc540c001466678d2da228149a107b51d5b65ce497603074';
const RUST_VERSION = '1.90.0';
const RUSTC_ARCHIVE_SHA256 = '48c2a42de9e92fcae8c24568f5fe40d5734696a6f80e83cc6d46eef1a78f13c9';
const RUST_STD_ARCHIVE_SHA256 = '663f4ab7945b392d5e5294dec1b050a66820a20e86f084ec37eeb0f2f7ff5569';
const CARGO_ARCHIVE_SHA256 = '9853db03d68578a30972e2755c89c66aec035fec641cf8f3a7117c81eec2578d';
const CONTAINER_IMAGE = 'ubuntu:24.04@sha256:f610ab94648195aa356059f5b41d6085c9d4d903c072430cdd1af7bdb646106b';
const UBUNTU_SNAPSHOT = '20261002T150000Z';
const CARGO_BUILD_SBF_VERSION = '4.1.0';
const PLATFORM_TOOLS_VERSION = 'v1.54';
const PLATFORM_TOOLS_ARCHIVE_SHA256 = 'fcc41631c7f77561bf5412218bf297501dccf0305ea280f338f0ace2aab9f31e';
const PLATFORM = 'linux/amd64';
const ARTIFACT = 'neal_access_stake.so';
const PLATFORM_RUSTC = '/root/.cache/solana/v1.54/platform-tools/rust/bin/rustc';

export const buildSbfEnvironment = () => ({ RUSTC: PLATFORM_RUSTC });

export const buildSbfCommand = () => [
  'cargo', 'build-sbf', '--skip-tools-install', '--no-rustup-override',
  '--tools-version', PLATFORM_TOOLS_VERSION, '--offline',
  '--manifest-path', 'programs/access-stake/Cargo.toml', '--sbf-out-dir', '/release',
  '--', '--locked', '--offline',
];

const parseCli = (argv) => {
  const values = { output: 'outputs/access-stake-release' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--commit') values.commit = argv[++index];
    else if (argument === '--output') values.output = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!values.commit) throw new Error('Missing --commit');
  return values;
};

const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const { capture = false, ...spawnOptions } = options;
  const child = spawn(command, args, { stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', ...spawnOptions });
  let stdout = '';
  child.stdout?.on('data', (chunk) => { stdout += chunk; });
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (code === 0) resolve(stdout.trim());
    else reject(new Error(`${command} exited ${code ?? signal}`));
  });
});

const resolveCommit = async (value) => {
  const commit = await run('git', ['rev-parse', '--verify', `${value}^{commit}`], { capture: true });
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error('Git returned an invalid commit SHA');
  return commit;
};

const extractCommit = async (commit, destination, archive) => {
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  await run('git', ['archive', '--format=tar', '--output', archive, commit]);
  await run('tar', ['-xf', archive, '-C', destination]);
};

const prefetchCargo = async (image, source, cargoHome) => {
  await fs.mkdir(cargoHome, { recursive: true, mode: 0o700 });
  await run('docker', [
    'run', '--rm', '--platform', PLATFORM,
    '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    '--volume', `${source}:/workspace:ro`,
    '--volume', `${cargoHome}:/cargo-home`,
    '--env', 'CARGO_HOME=/cargo-home',
    '--env', 'HOME=/root',
    '--workdir', '/workspace',
    image,
    'cargo', 'fetch', '--locked', '--manifest-path', 'programs/access-stake/Cargo.toml',
  ]);
};

const buildOnce = async (image, source, output, cargoHome, cargoTarget) => {
  await Promise.all([
    fs.mkdir(output, { recursive: true, mode: 0o700 }),
    fs.mkdir(cargoHome, { recursive: true, mode: 0o700 }),
    fs.mkdir(cargoTarget, { recursive: true, mode: 0o700 }),
  ]);
  const sbfEnvironment = buildSbfEnvironment();
  await run('docker', [
    'run', '--rm', '--platform', PLATFORM,
    '--network', 'none',
    '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    '--volume', `${source}:/workspace:ro`,
    '--volume', `${output}:/release`,
    '--volume', `${cargoHome}:/cargo-home:ro`,
    '--volume', `${cargoTarget}:/cargo-target`,
    '--env', 'CARGO_HOME=/cargo-home',
    '--env', 'CARGO_TARGET_DIR=/cargo-target',
    '--env', 'CARGO_NET_OFFLINE=true',
    '--env', `RUSTC=${sbfEnvironment.RUSTC}`,
    '--env', 'HOME=/root',
    '--workdir', '/workspace',
    image,
    ...buildSbfCommand(),
  ]);
  const artifact = path.join(output, ARTIFACT);
  const [sha256, stats] = await Promise.all([sha256File(artifact), fs.stat(artifact)]);
  return { artifact, sha256, bytes: stats.size };
};

async function main() {
  const options = parseCli(process.argv.slice(2));
  const commit = await resolveCommit(options.commit);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neal-access-stake-release-'));
  await fs.chmod(root, 0o700);
  try {
    const archive = path.join(root, 'source.tar');
    const sources = [path.join(root, 'source-1'), path.join(root, 'source-2')];
    await extractCommit(commit, sources[0], archive);
    await extractCommit(commit, sources[1], archive);
    const image = `neal-access-stake-sbf:${commit.slice(0, 12)}`;
    await run('docker', [
      'build', '--platform', PLATFORM,
      '--file', path.join(sources[0], 'infra/neal-access-rehearsal/Dockerfile.sbf'),
      '--build-arg', `AGAVE_VERSION=${AGAVE_VERSION}`,
      '--build-arg', `AGAVE_ARCHIVE_SHA256=${AGAVE_ARCHIVE_SHA256}`,
      '--build-arg', `RUST_VERSION=${RUST_VERSION}`,
      '--build-arg', `RUSTC_ARCHIVE_SHA256=${RUSTC_ARCHIVE_SHA256}`,
      '--build-arg', `RUST_STD_ARCHIVE_SHA256=${RUST_STD_ARCHIVE_SHA256}`,
      '--build-arg', `CARGO_ARCHIVE_SHA256=${CARGO_ARCHIVE_SHA256}`,
      '--build-arg', `UBUNTU_SNAPSHOT=${UBUNTU_SNAPSHOT}`,
      '--build-arg', `PLATFORM_TOOLS_VERSION=${PLATFORM_TOOLS_VERSION}`,
      '--build-arg', `PLATFORM_TOOLS_ARCHIVE_SHA256=${PLATFORM_TOOLS_ARCHIVE_SHA256}`,
      '--tag', image,
      sources[0],
    ]);
    const containerImageId = await run('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { capture: true });
    if (!/^sha256:[0-9a-f]{64}$/u.test(containerImageId)) throw new Error('Docker returned an invalid toolchain image identity');
    // Populate the dependency cache once, then mount it read-only into both builds.
    // Source trees and target directories are also separate and source is read-only,
    // so neither build can alter any input observed by the other.
    const cargoHome = path.join(root, 'cargo-home');
    await prefetchCargo(image, sources[0], cargoHome);
    const first = await buildOnce(image, sources[0], path.join(root, 'build-1'), cargoHome, path.join(root, 'cargo-target-1'));
    const second = await buildOnce(image, sources[1], path.join(root, 'build-2'), cargoHome, path.join(root, 'cargo-target-2'));
    if (first.sha256 !== second.sha256 || first.bytes !== second.bytes) {
      throw new Error(`Reproducibility failure: ${first.sha256}/${first.bytes} != ${second.sha256}/${second.bytes}`);
    }
    const output = path.resolve(options.output);
    await fs.mkdir(output, { recursive: true, mode: 0o755 });
    const outputArtifact = path.join(output, ARTIFACT);
    await fs.copyFile(first.artifact, outputArtifact);
    const manifest = validateReleaseManifest({
      schema: RELEASE_SCHEMA,
      sourceCommit: commit,
      createdAt: new Date().toISOString(),
      toolchain: {
        agaveVersion: AGAVE_VERSION,
        agaveArchiveSha256: AGAVE_ARCHIVE_SHA256,
        rustVersion: RUST_VERSION,
        rustcArchiveSha256: RUSTC_ARCHIVE_SHA256,
        rustStdArchiveSha256: RUST_STD_ARCHIVE_SHA256,
        cargoArchiveSha256: CARGO_ARCHIVE_SHA256,
        ubuntuSnapshot: UBUNTU_SNAPSHOT,
        cargoBuildSbfVersion: CARGO_BUILD_SBF_VERSION,
        platformToolsVersion: PLATFORM_TOOLS_VERSION,
        platformToolsArchiveSha256: PLATFORM_TOOLS_ARCHIVE_SHA256,
        containerImage: CONTAINER_IMAGE,
        containerImageId,
        platform: PLATFORM,
      },
      builds: [
        { ordinal: 1, sha256: first.sha256, bytes: first.bytes },
        { ordinal: 2, sha256: second.sha256, bytes: second.bytes },
      ],
      artifact: { file: ARTIFACT, sha256: first.sha256, bytes: first.bytes },
    });
    const manifestFile = path.join(output, 'release-manifest.json');
    const temporary = `${manifestFile}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
    await fs.rename(temporary, manifestFile);
    console.log(JSON.stringify({ manifest: manifestFile, artifact: outputArtifact, sha256: first.sha256, bytes: first.bytes }, null, 2));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`Access-stake reproducible build failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
