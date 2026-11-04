#!/usr/bin/env python3
"""Read-only, offline structural checks for an explicitly selected docs tree (v2).

Python 3.9+ standard library only. Errors are structural defects (broken links,
unresolved template fields, root escapes). Warnings are metadata and drift
signals (missing front-matter, unassigned owner, stale verification, backticked
paths that do not exist). This is not a Markdown renderer, security scanner,
test runner, approval checker or semantic validator.
"""
import argparse
import datetime
import json
import re
import sys
from collections import Counter
from pathlib import Path
from urllib.parse import unquote, urlsplit

DEST = r'(?:<([^>]+)>|((?:[^\s()]|\([^\s()]*\))+))'
INLINE_LINK = re.compile(r'!?\[[^\]\n]*\]\(\s*' + DEST + r'(?:\s+["\'][^\n]*?["\'])?\s*\)')
REFERENCE_DEF = re.compile(r'^\s{0,3}\[[^\]\n]+\]:\s*(?:<([^>]+)>|(\S+))', re.M)
TEMPLATE = re.compile(r'\[\[FILL:[\s\S]*?\]\]')
FRONT = re.compile(r'\A---\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)', re.S)
PATHLIKE = re.compile(r'^[\w.\-/]+\.(?:py|js|ts|tsx|jsx|md|json|ya?ml|toml|sh|go|rs|java|cfg|ini|sql|tf|rb|php|cs|c|h|cpp)$')
STATUSES = {'draft', 'reviewed', 'current', 'archived'}
NO_VALUE = {'', 'never', 'none', 'unknown', 'unassigned', 'n/a'}
SKIP_FRAGMENTS = {'', 'top'}


def within(path, root):
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def strip_fences(text):
    """Blank fenced code lines, keeping line boundaries."""
    lines, fence = [], None
    for line in text.splitlines():
        marker = re.match(r'^\s{0,3}(`{3,}|~{3,})', line)
        if fence:
            if marker and marker.group(1)[0] == fence[0] and len(marker.group(1)) >= len(fence):
                fence = None
            lines.append('')
        elif marker:
            fence = marker.group(1)
            lines.append('')
        else:
            lines.append(line)
    return lines


def prose_only(text):
    """Remove fenced blocks and inline code."""
    return '\n'.join(re.sub(r'(`+).*?\1', '', line) for line in strip_fences(text))


def inline_code_tokens(text):
    out = []
    for line in strip_fences(text):
        out.extend(re.findall(r'`([^`\n]+)`', line))
    return out


def anchors(text):
    """Conservative GitHub-style ATX heading anchors; duplicate suffixes included."""
    counts, found = Counter(), set()
    lines, fence = [], None
    for line in text.splitlines():
        marker = re.match(r'^\s{0,3}(`{3,}|~{3,})', line)
        if marker:
            if fence is None:
                fence = marker.group(1)
            elif marker.group(1)[0] == fence[0] and len(marker.group(1)) >= len(fence):
                fence = None
            continue
        if not fence:
            lines.append(line)
    for line in lines:
        match = re.match(r'^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+\s*)?$', line)
        if match:
            heading = re.sub(r'<[^>]+>', '', match.group(1)).strip().lower()
            heading = re.sub(r'\[([^\]]+)\]\([^)]*\)', r'\1', heading)
            heading = re.sub(r'[^\w\- ]', '', heading, flags=re.UNICODE).replace(' ', '-')
            count = counts[heading]
            counts[heading] += 1
            found.add(heading + (f'-{count}' if count else ''))
        for anchor in re.findall(r'<(?:a|h[1-6])\b[^>]*\b(?:id|name)=["\']([^"\']+)["\']', line, flags=re.I):
            found.add(anchor)
    return found


def front_matter(raw):
    """Parse simple `key: value` front-matter. Returns dict or None if absent."""
    match = FRONT.match(raw)
    if not match:
        return None
    meta = {}
    for line in match.group(1).splitlines():
        if ':' in line and not line.lstrip().startswith('#'):
            key, value = line.split(':', 1)
            value = re.sub(r'\s+#.*$', '', value).strip().strip('"\'')
            meta[key.strip().lower()] = value
    return meta


def parse_date(value):
    try:
        return datetime.date.fromisoformat(value)
    except ValueError:
        return None


def link_targets(prose):
    for match in list(INLINE_LINK.finditer(prose)) + list(REFERENCE_DEF.finditer(prose)):
        yield match, (match.group(1) or match.group(2))


def resolve(target_path, base, root):
    decoded = unquote(target_path)
    if decoded.startswith('/'):
        return (root / decoded.lstrip('/')).resolve()
    return (base / decoded).resolve() if decoded else None


def check(root, docs, index, today, stale_days, routes=None):
    errors, warnings, notes, report = [], [], [], []
    if not docs.is_dir():
        return [f'Docs directory does not exist: {docs}'], warnings, notes, report, 0, 0
    if not index.is_file():
        errors.append(f'Entry-point file does not exist: {index}')
    candidates = sorted(set(docs.rglob('*.md')) | ({index} if index.is_file() else set()))
    texts = {}
    for path in candidates:
        if not within(path.resolve(), root):
            errors.append(f'File escapes selected root (including symlinks): {path}')
            continue
        try:
            texts[path] = path.read_text(encoding='utf-8')
        except (OSError, UnicodeError) as exc:
            errors.append(f'Cannot read UTF-8 Markdown {path}: {exc}')
    link_count = 0
    for path, raw in texts.items():
        label = path.relative_to(root).as_posix()
        markers = TEMPLATE.findall(raw)
        if markers:
            errors.append(f'{label}: {len(markers)} unresolved [[FILL:...]] template marker(s)')
        prose = prose_only(raw)
        for match, target in link_targets(prose):
            location = f'{label}:{prose[:match.start()].count(chr(10)) + 1}'
            try:
                url = urlsplit(target)
            except ValueError:
                errors.append(f'{location}: malformed link {target!r}')
                continue
            if url.scheme or url.netloc:
                if url.scheme.lower() == 'file':
                    errors.append(f'{location}: file: link is not a portable repo reference')
                else:
                    notes.append(f'{location}: external/scheme link not checked')
                continue
            link_count += 1
            mapped = (routes or {}).get(label, {}).get(target)
            destination = (root / mapped).resolve() if mapped is not None else (resolve(url.path, path.parent, root) or path.resolve())
            if not within(destination, root):
                errors.append(f'{location}: link escapes selected root: {target}')
                continue
            if not destination.exists():
                errors.append(f'{location}: missing local target: {target}')
                continue
            fragment = unquote(url.fragment)
            if fragment.lower() not in SKIP_FRAGMENTS and destination.is_file() and destination.suffix.lower() == '.md':
                try:
                    target_text = texts.get(destination)
                    if target_text is None:
                        target_text = destination.read_text(encoding='utf-8')
                    if fragment not in anchors(target_text):
                        errors.append(f'{location}: heading anchor not found: {target}')
                except (OSError, UnicodeError) as exc:
                    errors.append(f'{location}: cannot check anchor: {exc}')

        # metadata and drift warnings
        meta = front_matter(raw)
        unverified = len(re.findall(r'\bnot (?:run|verified)\b', raw, flags=re.I))
        row = {'page': label, 'owner': '-', 'status': '-', 'last_verified': '-', 'unverified': unverified}
        if meta is None:
            warnings.append(f'{label}: no front-matter (owner, status, baseline, last_verified, verified_by)')
        else:
            owner = meta.get('owner', '')
            status = meta.get('status', '')
            verified = meta.get('last_verified', '')
            by = meta.get('verified_by', '')
            row.update(owner=owner or 'missing', status=status or 'missing', last_verified=verified or 'missing')
            if owner.lower() in NO_VALUE:
                warnings.append(f'{label}: owner is {owner or "missing"}')
            if status not in STATUSES:
                warnings.append(f'{label}: status {status or "missing"!r} not one of {sorted(STATUSES)}')
            if verified.lower() not in NO_VALUE:
                when = parse_date(verified)
                if when is None:
                    warnings.append(f'{label}: last_verified {verified!r} is not YYYY-MM-DD or "never"')
                else:
                    if when > today:
                        warnings.append(f'{label}: last_verified {verified} is in the future')
                    elif (today - when).days > stale_days and status != 'archived':
                        warnings.append(f'{label}: last_verified {verified} is older than {stale_days} days')
                    if by.lower() in NO_VALUE:
                        warnings.append(f'{label}: last_verified is set but verified_by is {by or "missing"}')
        seen = set()
        for token in inline_code_tokens(raw):
            if token in seen or not PATHLIKE.match(token) or '://' in token:
                continue
            seen.add(token)
            options = [(root / token.lstrip('/')), path.parent / token, docs / token] if '/' in token or token.startswith('.') \
                else [path.parent / token, root / token, docs / token]
            resolved = [o.resolve() for o in options]
            if not any(within(r, root) and r.exists() for r in resolved):
                warnings.append(f'{label}: backticked path not found in repository: {token}')
        report.append(row)

    root_readme = root / 'README.md'
    if root_readme.is_file() and within(root_readme.resolve(), root):
        try:
            text = prose_only(root_readme.read_text(encoding='utf-8'))
            linked = False
            for _, target in link_targets(text):
                url = urlsplit(target)
                if url.scheme or url.netloc:
                    continue
                dest = resolve(url.path, root, root)
                if dest is not None and dest == index.resolve():
                    linked = True
            if not linked:
                warnings.append(f'README.md: root README does not link to the docs entry point {index.relative_to(root)}')
        except (OSError, UnicodeError):
            warnings.append('README.md: cannot read root README as UTF-8')
    return errors, warnings, notes, report, len(texts), link_count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path, help='Explicit authorized project root')
    parser.add_argument('--docs', default='docs', help='Docs directory relative to root')
    parser.add_argument('--index', help='Entry-point Markdown path relative to root; default: DOCS/README.md')
    parser.add_argument('--report', action='store_true', help='Print a per-page metadata and unverified-claim table')
    parser.add_argument('--strict', action='store_true', help='Treat warnings as failures')
    parser.add_argument('--stale-days', type=int, default=180, help='Warn when last_verified is older (default 180)')
    parser.add_argument('--today', help='Override today (YYYY-MM-DD); for tests')
    parser.add_argument('--route-map', help='Explicit repository-relative JSON map for generated site routes')
    args = parser.parse_args()
    root = args.root.resolve()
    docs = (root / args.docs).resolve()
    index = (root / (args.index or str(Path(args.docs) / 'README.md'))).resolve()
    today = parse_date(args.today) if args.today else datetime.date.today()
    if today is None:
        parser.error('--today must be YYYY-MM-DD')
    if not root.is_dir() or not within(docs, root) or not within(index, root):
        parser.error('root must exist; docs and index must stay inside the selected root')
    routes = {}
    if args.route_map:
        selected = Path(args.route_map)
        if selected.is_absolute() or '..' in selected.parts:
            parser.error('route map must be a relative file inside root')
        mapping = (root / selected).resolve()
        if not within(mapping, root) or not mapping.is_file() or mapping.stat().st_size > 65536:
            parser.error('route map must be a bounded existing file inside root')
        try:
            routes = json.loads(mapping.read_text(encoding='utf-8'))
            if not isinstance(routes, dict):
                raise ValueError('expected an object')
            for source, targets in routes.items():
                if not isinstance(source, str) or not isinstance(targets, dict):
                    raise ValueError('expected document-to-link objects')
                for link, target in targets.items():
                    if not isinstance(link, str) or not isinstance(target, str) or not target or '\\' in target or urlsplit(target).scheme or Path(target).is_absolute() or '..' in Path(target).parts:
                        raise ValueError('route destinations must be relative paths inside root')
        except (OSError, UnicodeError, ValueError) as exc:
            parser.error(f'invalid route map: {exc}')
    errors, warnings, notes, report, count, links = check(root, docs, index, today, args.stale_days, routes)
    for error in errors:
        print(f'ERROR: {error}')
    for warning in warnings:
        print(f'WARN: {warning}')
    if args.report and report:
        print('\nPage | owner | status | last_verified | "not run/not verified" mentions')
        for row in report:
            print(f"{row['page']} | {row['owner']} | {row['status']} | {row['last_verified']} | {row['unverified']}")
        print()
    print(f'Checked {count} Markdown files and {links} local links; {len(notes)} external/scheme links skipped.')
    print('Structural and metadata checks only: no commands executed, no network, no semantic/approval/security validation.')
    failed = bool(errors) or (args.strict and bool(warnings))
    if failed:
        print(f'FAIL: {len(errors)} structural problem(s), {len(warnings)} warning(s){" (strict)" if args.strict else ""}.')
        return 1
    print(f'PASS: supported structural checks passed with {len(warnings)} warning(s); truth and readiness still require review.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
