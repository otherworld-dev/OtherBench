import { describe, expect, it } from 'vitest';
import { isPublicSuffix, parseAllowedSite, parseAllowedSites, siteListEntryFor } from '../src/domain/browser-sites.js';

const site = (raw: string): string => {
  const r = parseAllowedSite(raw);
  if (!r.ok) throw new Error(`${raw} was refused: ${r.problem}`);
  return r.site;
};
const problem = (raw: string): string => {
  const r = parseAllowedSite(raw);
  if (r.ok) throw new Error(`${raw} was taken as ${r.site}`);
  return r.problem;
};

describe('parseAllowedSite', () => {
  it('takes a host name or *. and a host name, canonical as the broker compares them', () => {
    expect(site('example.com')).toBe('example.com');
    expect(site('  Example.COM  ')).toBe('example.com');
    expect(site('example.com.')).toBe('example.com');
    expect(site('*.Example.com')).toBe('*.example.com');
    expect(site('news.bbc.co.uk')).toBe('news.bbc.co.uk');
    expect(site('*.bbc.co.uk')).toBe('*.bbc.co.uk');
    // IDNs as their punycode, the way normaliseHost (and so every host grant) spells them.
    expect(site('bücher.example')).toBe('xn--bcher-kva.example');
    expect(site('*.BÜCHER.example')).toBe('*.xn--bcher-kva.example');
    expect(site('xn--bcher-kva.example')).toBe('xn--bcher-kva.example');
  });

  it('refuses a scheme, a path, a query, a port and userinfo', () => {
    expect(problem('https://example.com')).toMatch(/scheme/);
    expect(problem('http://example.com/')).toMatch(/scheme/);
    expect(problem('example.com/login')).toMatch(/path/);
    expect(problem('example.com?q=1')).toMatch(/path/);
    expect(problem('example.com#top')).toMatch(/path/);
    expect(problem('example.com:443')).toMatch(/port/);
    expect(problem('*.example.com:8443')).toMatch(/port/);
    expect(problem('user@example.com')).toMatch(/user name/);
  });

  it('refuses any * but a leading *.', () => {
    for (const raw of ['*', '*.', '**.example.com', 'a.*.example.com', '*example.com', 'example.*', '*.*.example.com']) {
      expect(parseAllowedSite(raw).ok, raw).toBe(false);
    }
  });

  it('refuses IP addresses in every spelling', () => {
    for (const raw of ['8.8.8.8', '127.0.0.1', '10.0.0.5', '192.168.1.1', '2130706433', '0x7f.1', '::1', '[::1]', '2606:4700:4700::1111', '*.1.2.3.4']) {
      expect(problem(raw), raw).toMatch(/IP address|website name/);
    }
    expect(problem('8.8.8.8')).toMatch(/IP address/);
    expect(problem('2130706433')).toMatch(/IP address/);
    expect(problem('::1')).toMatch(/IP address/);
  });

  it('refuses localhost and local network names', () => {
    for (const raw of ['localhost', 'LOCALHOST.', '*.localhost', 'app.localhost', 'printer.local', '*.local', 'nas.lan', 'box.home.arpa', 'svc.internal', 'host.localdomain']) {
      expect(problem(raw), raw).toMatch(/local network name/);
    }
    // A name with no dot is a different machine on every network.
    expect(problem('router')).toMatch(/top-level domain or a local name/);
  });

  it('refuses bare top-level domains and wildcards over them', () => {
    expect(problem('com')).toMatch(/top-level domain/);
    expect(problem('*.com')).toMatch(/whole top-level domain/);
    expect(problem('*.uk')).toMatch(/whole top-level domain/);
    expect(problem('*.test')).toMatch(/whole top-level domain/);
  });

  it('refuses public suffixes, as patterns and as names', () => {
    for (const raw of ['*.co.uk', '*.org.uk', '*.ac.uk', '*.gov.uk', '*.com.au', '*.co.jp', '*.com.br', '*.co.nz', '*.github.io', '*.herokuapp.com', '*.vercel.app', '*.blogspot.com']) {
      expect(problem(raw), raw).toMatch(/public suffix/);
    }
    expect(problem('co.uk')).toMatch(/public suffix/);
    expect(problem('*.CO.UK.')).toMatch(/public suffix/);
  });

  it('refuses what is not a host name at all', () => {
    for (const raw of ['', '   ', 'exa mple.com', 'ex_ample.com', '-example.com', 'example-.com', 'example..com', '.example.com', 'exa\\mple.com', `${'a'.repeat(250)}.com`]) {
      expect(parseAllowedSite(raw).ok, JSON.stringify(raw)).toBe(false);
    }
  });
});

describe('isPublicSuffix', () => {
  it('knows the common shapes, and leaves ordinary domains alone', () => {
    for (const base of ['com', 'co.uk', 'com.au', 'or.jp', 'gob.mx', 'github.io', 'pages.dev']) expect(isPublicSuffix(base), base).toBe(true);
    for (const base of ['example.com', 'bbc.co.uk', 'example.co', 'web.de', 'example.io', 'github.com', 'news.example.co.uk']) expect(isPublicSuffix(base), base).toBe(false);
  });
});

describe('parseAllowedSites', () => {
  it('makes the list canonical and drops repeats, in order', () => {
    expect(parseAllowedSites(['Example.com', '*.example.com', 'example.com.', 'bücher.example'])).toEqual({ ok: true, sites: ['example.com', '*.example.com', 'xn--bcher-kva.example'] });
    expect(parseAllowedSites([])).toEqual({ ok: true, sites: [] });
  });

  it('names the first bad entry as typed', () => {
    expect(parseAllowedSites(['example.com', 'https://bad.example/', '*.com'])).toMatchObject({ ok: false, entry: 'https://bad.example/' });
  });
});

describe('siteListEntryFor', () => {
  it('matches an exact entry on that host only, never its subdomains', () => {
    expect(siteListEntryFor('example.com', ['example.com'])).toBe('example.com');
    expect(siteListEntryFor('EXAMPLE.com.', ['example.com'])).toBe('example.com');
    expect(siteListEntryFor('www.example.com', ['example.com'])).toBeNull();
    expect(siteListEntryFor('badexample.com', ['example.com'])).toBeNull();
  });

  it('matches a wildcard on subdomains at any depth, but not the name itself', () => {
    expect(siteListEntryFor('www.example.com', ['*.example.com'])).toBe('*.example.com');
    expect(siteListEntryFor('a.b.example.com', ['*.example.com'])).toBe('*.example.com');
    expect(siteListEntryFor('example.com', ['*.example.com'])).toBeNull();
    expect(siteListEntryFor('notexample.com', ['*.example.com'])).toBeNull();
    expect(siteListEntryFor('example.com', ['*.example.com', 'example.com'])).toBe('example.com');
  });

  it('compares IDNs in one spelling', () => {
    expect(siteListEntryFor('xn--bcher-kva.example', ['bücher.example'])).toBe('xn--bcher-kva.example');
    expect(siteListEntryFor('bücher.example', ['xn--bcher-kva.example'])).toBe('xn--bcher-kva.example');
  });

  it("never matches through an entry that couldn't be listed, such as one synced from elsewhere", () => {
    expect(siteListEntryFor('127.0.0.1', ['127.0.0.1'])).toBeNull();
    expect(siteListEntryFor('localhost', ['localhost'])).toBeNull();
    expect(siteListEntryFor('10.0.0.5', ['10.0.0.5', '*.0.0.5'])).toBeNull();
    expect(siteListEntryFor('www.example.co.uk', ['*.co.uk'])).toBeNull();
    expect(siteListEntryFor('router', ['router'])).toBeNull();
    expect(siteListEntryFor('example.com', ['https://example.com/'])).toBeNull();
    expect(siteListEntryFor('example.com', [42, null, 'example.com'])).toBe('example.com');
    expect(siteListEntryFor('example.com', 'example.com')).toBeNull();
    expect(siteListEntryFor(null, ['example.com'])).toBeNull();
  });
});
