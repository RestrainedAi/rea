#!/usr/bin/env python3
"""Offline fixture tests; no user repository or network access."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'check_docs.py'

class CheckerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='docs-check-test-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'project'
        (self.root / 'docs').mkdir(parents=True)
        self.index = self.root / 'docs' / 'README.md'
        self.index.write_text('# Start\n', encoding='utf-8')

    META = '---\nowner: Dana\nstatus: current\naudience: team\nbaseline: abc123\nlast_verified: 2026-10-01\nverified_by: Dana\n---\n'

    def run_check(self, expected, *extra):
        before = {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        result = subprocess.run([sys.executable, str(SCRIPT), '--root', str(self.root), *extra], capture_output=True, text=True)
        self.assertEqual(expected, result.returncode, result.stdout + result.stderr)
        after = {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        self.assertEqual(before, after, 'checker must not mutate source files')
        return result.stdout + result.stderr

    def test_valid_links_fences_reference_and_duplicate_anchor(self):
        self.index.write_text('# Start\n[Guide](guide.md#setup-1)\n[ref]: guide.md#setup\n[External](https://example.invalid/)\n```md\n[Fake](missing.md)\n```\n`[Fake](missing.md)`\n', encoding='utf-8')
        (self.root/'docs'/'guide.md').write_text('# Setup\n## Setup\n', encoding='utf-8')
        self.assertIn('1 external/scheme links skipped', self.run_check(0))

    def test_missing_index(self):
        self.index.unlink()
        self.assertIn('Entry-point file does not exist', self.run_check(1))

    def test_broken_link(self):
        self.index.write_text('[Broken](missing.md)\n', encoding='utf-8')
        self.assertIn('missing local target', self.run_check(1))

    def test_broken_anchor(self):
        self.index.write_text('# Start\n[Broken](#missing)\n', encoding='utf-8')
        self.assertIn('heading anchor not found', self.run_check(1))

    def test_template_marker(self):
        self.index.write_text('[[FILL: owner]]\n', encoding='utf-8')
        self.assertIn('unresolved', self.run_check(1))

    def test_parent_path_escape(self):
        self.index.write_text('[Outside](../../outside.md)\n', encoding='utf-8')
        (self.base/'outside.md').write_text('outside fixture', encoding='utf-8')
        self.assertIn('link escapes selected root', self.run_check(1))

    def test_symlink_escape(self):
        outside = self.base/'outside.md'
        outside.write_text('outside fixture', encoding='utf-8')
        (self.root/'docs'/'outside.md').symlink_to(outside)
        self.assertIn('File escapes selected root', self.run_check(1))

    def test_file_url(self):
        self.index.write_text('[Bad](file:///tmp/outside.md)\n', encoding='utf-8')
        self.assertIn('not a portable repo reference', self.run_check(1))

    def test_invalid_scope(self):
        self.assertIn('must stay inside', self.run_check(2, '--docs', '..'))

    def test_custom_index_and_root_relative_link(self):
        (self.root/'handbook').mkdir()
        (self.root/'handbook'/'start.md').write_text('[Home](/docs/README.md#start)', encoding='utf-8')
        self.run_check(0, '--docs', 'handbook', '--index', 'handbook/start.md')

    def test_unreadable_utf8(self):
        self.index.write_bytes(b'\xff\xfe')
        self.assertIn('Cannot read UTF-8', self.run_check(1))

    # ---- v2 additions ----
    def test_parenthesized_filename_and_top_fragment(self):
        (self.root/'docs'/'a_(v2).md').write_text('# A\n', encoding='utf-8')
        self.index.write_text('# Start\n[A](a_(v2).md) [Top](#top)\n', encoding='utf-8')
        self.run_check(0)

    def test_missing_front_matter_warns_but_passes(self):
        out = self.run_check(0)
        self.assertIn('no front-matter', out)

    def test_strict_fails_on_warning(self):
        self.assertIn('FAIL', self.run_check(1, '--strict'))

    def test_clean_metadata_has_no_warnings(self):
        self.index.write_text(self.META + '# Start\n', encoding='utf-8')
        out = self.run_check(0, '--strict', '--today', '2026-10-26')
        self.assertNotIn('WARN', out)

    def test_unassigned_owner_and_never_verified(self):
        self.index.write_text('---\nowner: unassigned\nstatus: draft\nlast_verified: never\n---\n# Start\n', encoding='utf-8')
        out = self.run_check(0)
        self.assertIn('owner is unassigned', out)
        self.assertNotIn('older than', out)

    def test_stale_verification_and_missing_verifier(self):
        self.index.write_text('---\nowner: Dana\nstatus: current\nlast_verified: 2025-01-01\nverified_by: none\n---\n# Start\n', encoding='utf-8')
        out = self.run_check(0, '--today', '2026-10-26')
        self.assertIn('older than 180 days', out)
        self.assertIn('verified_by is none', out)

    def test_bad_status_and_date(self):
        self.index.write_text('---\nowner: Dana\nstatus: done\nlast_verified: yesterday\nverified_by: Dana\n---\n# Start\n', encoding='utf-8')
        out = self.run_check(0)
        self.assertIn("status 'done'", out)
        self.assertIn('not YYYY-MM-DD', out)

    def test_report_table_counts_unverified(self):
        self.index.write_text(self.META + '# Start\nCommand: not run. Other: Not verified.\n', encoding='utf-8')
        out = self.run_check(0, '--report', '--today', '2026-10-26')
        self.assertIn('docs/README.md | Dana | current | 2026-10-01 | 2', out)

    def test_root_readme_link_warning_and_ok(self):
        (self.root/'README.md').write_text('# Proj\nNo link here.\n', encoding='utf-8')
        self.assertIn('root README does not link', self.run_check(0))
        (self.root/'README.md').write_text('# Proj\nSee [docs](docs/README.md).\n', encoding='utf-8')
        self.assertNotIn('root README does not link', self.run_check(0))

    def test_backticked_path_drift(self):
        (self.root/'src').mkdir()
        (self.root/'src'/'real.py').write_text('x=1\n', encoding='utf-8')
        self.index.write_text('# Start\n`src/real.py` and `src/gone.py` and `https://x.invalid/a.py`\n```\n`src/fenced.py`\n```\n', encoding='utf-8')
        out = self.run_check(0)
        self.assertIn('src/gone.py', out)
        self.assertNotIn('src/real.py', out)
        self.assertNotIn('fenced.py', out)

    def test_template_marker_inside_fence_still_fails(self):
        self.index.write_text('# Start\n```\n[[FILL: x]]\n```\n', encoding='utf-8')
        self.assertIn('unresolved', self.run_check(1))

if __name__ == '__main__':
    unittest.main(verbosity=2)
