/**
 * Minimal glob-matching uten ekstern dependency. Støtter `*` (innen ett
 * stinivå), `**` (vilkårlig dybde) og `?` (ett tegn). Tilstrekkelig for
 * allowedPaths/disallowedPaths i oppgavekontrakter — ikke en generell
 * glob-implementasjon.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i++;
        if (pattern[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c ?? '')) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  out += '$';
  return new RegExp(out);
}

export function matchesAnyGlob(path: string, patterns: readonly string[]): boolean {
  const normalized = path.replace(/^\.\//, '');
  return patterns.some((p) => globToRegExp(p).test(normalized));
}
