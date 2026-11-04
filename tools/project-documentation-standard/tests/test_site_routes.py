"""REA-only route-map fixtures; no network or real project data."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'check_docs.py'


class SiteRoutes(unittest.TestCase):
    def run_fixture(self, routes, *, asset=True, extra_link=False):
        with tempfile.TemporaryDirectory(prefix='rea-doc-routes-') as temp:
            root = Path(temp)
            (root / 'docs' / 'public').mkdir(parents=True)
            content = '# Start\n[Catalog](/rea/product-catalog.json)\n'
            if extra_link:
                content += '[Unmapped](absent.json)\n'
            (root / 'docs' / 'README.md').write_text(content, encoding='utf-8')
            if asset:
                (root / 'docs' / 'public' / 'product-catalog.json').write_text('{}')
            (root / 'routes.json').write_text(json.dumps(routes), encoding='utf-8')
            return subprocess.run([sys.executable, str(SCRIPT), '--root', str(root),
                '--route-map', 'routes.json'], capture_output=True, text=True)

    def test_declared_renderer_route_uses_existing_asset(self):
        result = self.run_fixture({'docs/README.md': {'/rea/product-catalog.json': 'docs/public/product-catalog.json'}})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_a_map_does_not_make_an_absent_asset_exist(self):
        result = self.run_fixture({'docs/README.md': {'/rea/product-catalog.json': 'docs/public/product-catalog.json'}}, asset=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('missing local target', result.stdout)

    def test_an_unmapped_missing_link_still_fails(self):
        result = self.run_fixture({'docs/README.md': {'/rea/product-catalog.json': 'docs/public/product-catalog.json'}}, extra_link=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn('absent.json', result.stdout)

    def test_a_route_cannot_authorize_a_root_escape(self):
        result = self.run_fixture({'docs/README.md': {'/rea/product-catalog.json': '../outside.json'}})
        self.assertEqual(result.returncode, 2)


if __name__ == '__main__':
    unittest.main(verbosity=2)
