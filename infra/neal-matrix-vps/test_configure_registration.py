import importlib.util
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).with_name("configure_registration.py")
SPEC = importlib.util.spec_from_file_location("configure_registration", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class RegistrationPolicyTests(unittest.TestCase):
    def test_captcha_policy_is_verified_and_password_protected(self) -> None:
        policy = MODULE.render_policy("captcha")
        self.assertIn("enable_registration_without_verification: false", policy)
        self.assertIn("registration_requires_token: false", policy)
        self.assertIn("enable_registration_captcha: true", policy)
        self.assertIn("recaptcha_private_key_path: /data/recaptcha-private-key", policy)
        self.assertIn("minimum_length: 12", policy)

    def test_invite_only_policy_stays_fail_closed(self) -> None:
        policy = MODULE.render_policy("invite-only")
        self.assertIn("registration_requires_token: true", policy)
        self.assertIn("enable_registration_captcha: false", policy)
        self.assertNotIn("recaptcha_public_key_path", policy)

    def test_legacy_policy_is_upgraded(self) -> None:
        original = f"server_name: example.org\n{MODULE.LEGACY_BLOCK}\nreport_stats: false\n"
        updated = MODULE.replace_policy(original, "captcha")
        self.assertNotIn("enable_registration_without_verification: true", updated)
        self.assertEqual(updated.count(MODULE.BEGIN), 1)
        self.assertEqual(updated.count(MODULE.END), 1)

    def test_managed_policy_can_switch_back_to_invite_only(self) -> None:
        original = f"server_name: example.org\n{MODULE.render_policy('captcha')}\n"
        updated = MODULE.replace_policy(original, "invite-only")
        self.assertIn("registration_requires_token: true", updated)
        self.assertNotIn("recaptcha_public_key_path", updated)

    def test_unmanaged_password_policy_is_not_overwritten(self) -> None:
        original = f"{MODULE.LEGACY_BLOCK}\npassword_config:\n  enabled: false\n"
        with self.assertRaisesRegex(ValueError, "unmanaged"):
            MODULE.replace_policy(original, "captcha")


if __name__ == "__main__":
    unittest.main()
