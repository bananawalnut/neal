export type LaunchControl = {
  schema: 'neal.launch-control/v1';
  status: string;
  canonicalRoute: 'pumpfun';
  network: 'solana';
  token: {
    name: string;
    symbol: string;
    metadataUri: string | null;
    imagePath: string | null;
    bannerPath: string | null;
    bannerUrl?: string | null;
    description: string | null;
    website: string | null;
    socialLinks: unknown[];
  };
  pumpfun: {
    quoteAsset: 'SOL';
    mayhemMode: boolean;
    cashBack: boolean;
    creatorWallet: string | null;
    creatorFeeRecipient: string | null;
    initialCreatorPurchaseLamports: string | null;
    initialCreatorPurchaseSol: number | null;
    launchAt: string | null;
  };
  programs: {
    economics: {
      questTreasury: {
        wallet: string | null;
        creatorFeeShareBasisPoints: number;
      };
      creatorFeeRouting: {
        status: 'planned' | 'ready_for_signature' | 'active';
        shares: Array<{
          role: 'dev' | 'quest_treasury';
          shareBasisPoints: number;
          wallet: string | null;
        }>;
      };
    };
  };
  execution: {
    mintAddress: string | null;
    creationTransaction: string | null;
    finalHumanWalletReviewRequired: boolean;
  };
};

export type AssetManifest = {
  schema: 'neal.launch-assets/v1';
  generatedAt: string;
  metadataUri: string;
  image: { path: string; sha256: string; bytes: number };
  banner?: { path: string; url: string; sha256: string; bytes: number } | null;
  launchConfig: { sha256: string; bytes: number };
};

export type MetadataDocument = {
  name: string;
  symbol: string;
  description: string | null;
  image: string;
  external_url: string | null;
  showName?: boolean;
  createdOn?: string;
  website?: string;
  github?: string;
  banner?: string;
  attributes: Array<{ trait_type: string; value: string }>;
  properties: { category: string; files: Array<{ uri: string; type: string }> };
};

export type ReviewInput = {
  metadataUri: string;
  maximumPurchaseLamports: string;
  launchAt: string;
  rpcEndpoint: string;
};

export type Check = {
  status: 'pass' | 'blocker' | 'warning';
  label: string;
  detail: string;
};
