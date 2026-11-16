# Copyright (c) 2001-2026 Convertigo SA.
#
# Reads a public web page for a No Code agent, as text: python3 c8o_web_read.py URL [--offset N] [--links]
#
# Under agents.tool_policy=sandboxed-shell the shell of a No Code Vibe session is confined by Landlock, which holds the
# file system and leaves the network open, so it already reaches the web. Vibe 3 has no web tool of its own: its
# web_search and open_url are Mistral's web_search connector, which it sets up only with a provider of the Mistral
# backend and a Mistral key, and the Convertigo gateway does not relay it. The Bridge names this file in the No Code
# instructions of such a session (noCodeWebReadRule in js/agent_bridge_common.js); it lies in sandbox/python, which the
# confined process reads.
#
# The page comes back as text (HTML is reduced to its headings, paragraphs, lists and tables), at most MAX_CHARS
# characters a call: Vibe sets a tool answer of more than about 16,000 characters aside in a file and shows the model an
# excerpt. The rest is read with --offset. Only http and https, public addresses (every address the host resolves to,
# and each redirect): the engine's own services and the cluster stay out of the reader's reach. That is a guard against
# mistakes, not a boundary: the confined shell reaches the same network.
# Standard library only: it runs on the CPython behind Vibe's venv.
import argparse
import gzip
import ipaddress
import os
import re
import socket
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
import zlib
from html.parser import HTMLParser

MAX_CHARS = 12000
MIN_CHARS = 1000
MAX_BYTES = 5 * 1024 * 1024
MAX_DECODED_BYTES = 20 * 1024 * 1024
DEFAULT_TIMEOUT = 30
MAX_TIMEOUT = 120
MAX_REDIRECTS = 5
USER_AGENT = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 "
              "ConvertigoTigo/1.0")
CA_BUNDLES = ("/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/cert.pem")
TEXT_TYPE = re.compile(r"^(text/.+|application/(json|xml|javascript|ecmascript|x-javascript|ld\+json|x-ndjson|"
                       r"csv|yaml|x-yaml|toml)|application/.+\+(json|xml))$")
HTML_TYPES = ("text/html", "application/xhtml+xml")


class ReadError(Exception):
    pass


def check_public(url):
    """The URL, if http(s) on a host whose every address is public; ReadError otherwise."""
    try:
        parts = urllib.parse.urlsplit(url)
        port = parts.port
    except ValueError as error:
        raise ReadError("not a valid URL: %s (%s)" % (url, error))
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ReadError("only http and https addresses are read: %s" % url)
    host = parts.hostname
    port = port or (443 if parts.scheme == "https" else 80)
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError) as error:
        raise ReadError("unknown host %s (%s)" % (host, error))
    for info in infos:
        address = ipaddress.ip_address(info[4][0].split("%", 1)[0])
        mapped = getattr(address, "ipv4_mapped", None)
        if not (mapped or address).is_global:
            raise ReadError("%s is not a public address (%s): only public pages are read" % (host, address))
    return url


class PublicRedirects(urllib.request.HTTPRedirectHandler):
    max_redirections = MAX_REDIRECTS

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_public(urllib.parse.urljoin(req.full_url, newurl))
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def ssl_context():
    context = ssl.create_default_context()
    if not context.cert_store_stats().get("x509_ca"):
        for bundle in CA_BUNDLES:
            if os.path.isfile(bundle):
                try:
                    context.load_verify_locations(cafile=bundle)
                    break
                except (OSError, ssl.SSLError):
                    continue
    return context


def decoded_body(raw, encoding):
    encoding = (encoding or "").strip().lower()
    if encoding in ("", "identity"):
        return raw
    try:
        if encoding in ("gzip", "x-gzip"):
            return zlib.decompressobj(16 + zlib.MAX_WBITS).decompress(raw, MAX_DECODED_BYTES)
        if encoding == "deflate":
            try:
                return zlib.decompressobj().decompress(raw, MAX_DECODED_BYTES)
            except zlib.error:
                return zlib.decompressobj(-zlib.MAX_WBITS).decompress(raw, MAX_DECODED_BYTES)
    except zlib.error as error:
        raise ReadError("the page could not be decompressed (%s)" % error)
    raise ReadError("the page is compressed with %s, which is not read" % encoding)


def fetch(url, timeout):
    """(final URL, content type, charset, body bytes, cut at MAX_BYTES)."""
    check_public(url)
    opener = urllib.request.build_opener(PublicRedirects(), urllib.request.HTTPSHandler(context=ssl_context()))
    request = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.9,*/*;q=0.5",
        "Accept-Language": "fr,en;q=0.8",
        "Accept-Encoding": "gzip, deflate",
    })
    try:
        with opener.open(request, timeout=timeout) as response:
            raw = response.read(MAX_BYTES + 1)
            headers = response.headers
            final = response.geturl()
    except urllib.error.HTTPError as error:
        raise ReadError("HTTP %d %s for %s" % (error.code, error.reason, error.geturl() or url))
    except urllib.error.URLError as error:
        reason = error.reason
        if isinstance(reason, ReadError):
            raise reason
        raise ReadError("%s could not be reached (%s)" % (url, reason))
    except (socket.timeout, TimeoutError):
        raise ReadError("%s did not answer within %d s" % (url, timeout))
    cut = len(raw) > MAX_BYTES
    body = decoded_body(raw[:MAX_BYTES], headers.get("Content-Encoding"))
    return final, headers.get_content_type(), headers.get_content_charset(), body, cut


META_CHARSET = re.compile(rb"""<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_.:-]+)""", re.I)


def page_text(body, charset, html):
    if not charset and html:
        found = META_CHARSET.search(body[:4096])
        charset = found.group(1).decode("ascii") if found else None
    for candidate in (charset, "utf-8"):
        if not candidate:
            continue
        try:
            return body.decode(candidate, errors="replace")
        except LookupError:
            continue
    return body.decode("utf-8", errors="replace")


SKIPPED = {"script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "select", "math"}
BLOCKS = {"address", "article", "aside", "blockquote", "body", "caption", "dd", "details", "dialog", "div", "dl", "dt",
          "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr",
          "li", "main", "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "tfoot", "thead", "tr", "ul",
          "br"}
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
# kept apart from their neighbours: menus put links and buttons side by side with no space between them
SEPARATED = {"a", "button", "label", "option"}
EMPTY_LINE = re.compile(r"^(#+|-|\|)?\s*$")


class TextOfPage(HTMLParser):
    """The text of an HTML page: one line per block, `#` before headings, `- ` before list items, ` | ` between cells,
    and with links, [text](address) for each link to another page."""

    def __init__(self, base, links):
        super().__init__(convert_charrefs=True)
        self.base = base
        self.links = links
        self.lines = []
        self.line = []
        self.skipping = []
        self.pre = 0
        self.title = []
        self.in_title = False
        self.link = None

    def flush(self):
        text = "".join(self.line)
        text = text if self.pre else re.sub(r"[ \t\r\n\f\v]+", " ", text).strip()
        if not EMPTY_LINE.match(text):
            self.lines.append(text.rstrip())
        self.line = []

    def handle_starttag(self, tag, attrs):
        if tag in SKIPPED:
            self.skipping.append(tag)
            return
        if self.skipping:
            return
        attributes = dict(attrs)
        if tag == "title":
            self.in_title = True
        elif tag == "base" and attributes.get("href"):
            self.base = urllib.parse.urljoin(self.base, attributes["href"])
        if tag in BLOCKS:
            self.flush()
        elif tag in SEPARATED and not self.pre:
            self.line.append(" ")
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self.line.append("#" * int(tag[1]) + " ")
        elif tag == "li":
            self.line.append("- ")
        elif tag in ("td", "th") and "".join(self.line).strip():
            self.line.append(" | ")
        elif tag == "pre":
            self.pre += 1
        elif tag == "img" and attributes.get("alt"):
            self.line.append(" " + attributes["alt"].strip() + " ")
        elif tag == "a" and self.links:
            self.link = (attributes.get("href") or "", len(self.lines), len(self.line))

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if self.skipping:
            if tag == self.skipping[-1]:
                self.skipping.pop()
            return
        if tag == "title":
            self.in_title = False
            return
        if tag == "a" and self.link is not None:
            self.close_link()
        if tag in SEPARATED and not self.pre:
            self.line.append(" ")
        if tag == "pre" and self.pre:
            self.flush()
            self.pre -= 1
        if tag in BLOCKS:
            self.flush()

    def close_link(self):
        href, line_index, start = self.link
        self.link = None
        href = href.strip()
        if not href or href.startswith(("#", "javascript:", "mailto:", "tel:", "data:")):
            return
        target = urllib.parse.urljoin(self.base, href)
        if not target.startswith(("http://", "https://")):
            return
        if line_index == len(self.lines):
            text = re.sub(r"\s+", " ", "".join(self.line[start:])).strip()
            if text:
                self.line[start:] = ["[" + text + "](" + target + ")"]
                return
        self.line.append(" (" + target + ")")

    def handle_data(self, data):
        if self.skipping:
            return
        if self.in_title:
            self.title.append(data)
            return
        self.line.append(data)

    def text(self):
        self.flush()
        return "\n".join(self.lines)


def html_to_text(html, base, links=False):
    """(title, text) of an HTML page."""
    parser = TextOfPage(base, links)
    parser.feed(html)
    parser.close()
    return re.sub(r"\s+", " ", "".join(parser.title)).strip(), parser.text()


def plain_text(text):
    lines = [line.rstrip() for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def excerpt(text, offset, budget):
    """(the part of text from offset that fits budget, where the next call starts, or None at the end)."""
    end = offset + budget
    if end >= len(text):
        return text[offset:], None
    cut = text.rfind("\n", offset, end)
    if cut <= offset + budget * 4 // 5:
        cut = end
    return text[offset:cut], cut + (1 if text[cut:cut + 1] == "\n" else 0)


def render(url, title, content_type, text, offset, max_chars, cut):
    total = len(text)
    if offset > total:
        raise ReadError("--offset %d is past the end of the page (%d characters)" % (offset, total))
    head = ["URL: " + url]
    if title:
        head.append("Title: " + title)
    budget = max(200, max_chars - sum(len(line) + 1 for line in head) - 160)
    part, next_offset = excerpt(text, offset, budget)
    end = offset + len(part)
    head.append("Content: %s, characters %d-%d of %d%s" % (content_type, offset, end, total,
                                                             " (the page was cut at 5 MB)" if cut else ""))
    out = "\n".join(head) + "\n\n" + part
    if next_offset is not None:
        out += "\n\n[%d more characters: run it again with --offset %d]" % (total - next_offset, next_offset)
    elif not part.strip():
        out += "(no text on this page)"
    return out


def read(url, offset=0, max_chars=MAX_CHARS, timeout=DEFAULT_TIMEOUT, links=False):
    if not re.match(r"^[A-Za-z][A-Za-z0-9+.-]*://", url):
        url = "https://" + url.lstrip("/")
    final, content_type, charset, body, cut = fetch(url, timeout)
    html = content_type in HTML_TYPES
    if not html and not TEXT_TYPE.match(content_type):
        raise ReadError("%s is %s (%d bytes), not a text page: it is not read here" % (final, content_type, len(body)))
    text = page_text(body, charset, html)
    title = ""
    if html:
        title, text = html_to_text(text, final, links)
    else:
        text = plain_text(text)
    return render(final, title, content_type, text, offset, max_chars, cut)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="c8o_web_read.py", description="Reads a public web page as text.")
    parser.add_argument("url", help="http or https address of the page")
    parser.add_argument("--offset", type=int, default=0, help="first character to show (the previous call gives it)")
    parser.add_argument("--max-chars", type=int, default=MAX_CHARS, help="at most this many characters (%d at most)" % MAX_CHARS)
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT, help="seconds to wait (%d at most)" % MAX_TIMEOUT)
    parser.add_argument("--links", action="store_true", help="show where the links go, as [text](address)")
    args = parser.parse_args(argv)
    try:
        print(read(args.url, max(0, args.offset), min(MAX_CHARS, max(MIN_CHARS, args.max_chars)),
                   min(MAX_TIMEOUT, max(1, args.timeout)), args.links))
        return 0
    except ReadError as error:
        print("Cannot read the page: %s" % error)
        return 1


if __name__ == "__main__":
    sys.exit(main())
