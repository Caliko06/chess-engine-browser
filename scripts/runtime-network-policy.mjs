export const runtimeNetworkPatterns = [
  { name: "fetch(", regex: /\bfetch\s*\(/u },
  { name: "bracketed fetch", regex: /\b(globalThis|window|self)\s*\[\s*["']fetch["']\s*\]/u },
  { name: "XMLHttpRequest", regex: /\bXMLHttpRequest\b/u },
  { name: "WebSocket", regex: /\bWebSocket\b/u },
  { name: "EventSource", regex: /\bEventSource\b/u },
  { name: "navigator.sendBeacon", regex: /\bnavigator\s*\.\s*sendBeacon\s*\(/u },
  { name: "RTCPeerConnection", regex: /\bRTC(?:PeerConnection|DataChannel)\b/u },
  { name: "http://", regex: /http:\/\//u },
  { name: "https://", regex: /https:\/\//u },
  { name: "std::net", regex: /\bstd::net\b/u },
  { name: "TcpStream/TcpListener", regex: /\bTcp(Stream|Listener)\b/u },
  { name: "UdpSocket", regex: /\bUdpSocket\b/u },
  {
    name: "Rust subprocess",
    regex: /\bstd::process::Command\b|\bCommand::new\s*\(|std::process\s*::\s*\{[^}]*\bCommand\b/u
  },
  { name: "Rust unsafe", regex: /\bunsafe\b|\bextern\s+"C"/u },
  {
    name: "node network import",
    regex: /from\s+["']node:(http|https|http2|net|tls|dns|dgram)["']/u
  },
  {
    name: "bare network import",
    regex: /from\s+["'](http|https|http2|net|tls|dns|dgram|undici|axios|node-fetch)["']/u
  },
  {
    name: "side-effect network import",
    regex: /\bimport\s+["'](?:node:)?(http|https|http2|net|tls|dns|dgram|undici|axios|node-fetch)["']/u
  },
  {
    name: "CommonJS network require",
    regex: /require\s*\(\s*["'](?:node:)?(http|https|http2|net|tls|dns|dgram|undici|axios|node-fetch)["']\s*\)/u
  },
  {
    name: "dynamic network import",
    regex: /import\s*\(\s*["'](?:node:)?(http|https|http2|net|tls|dns|dgram|undici|axios|node-fetch)["']\s*\)/u
  },
  {
    name: "node child_process import",
    regex: /from\s+["']node:child_process["']|from\s+["']child_process["']|require\s*\(\s*["'](?:node:)?child_process["']\s*\)/u
  },
  { name: "CSS @import", regex: /@import\b/u },
  { name: "CSS remote url(", regex: /\burl\s*\(\s*["']?(?:https?:)?\/\//u }
];

export const rustSubprocessPattern = runtimeNetworkPatterns.find(
  (pattern) => pattern.name === "Rust subprocess"
);

export const buildScriptNetworkPatterns = runtimeNetworkPatterns.filter((pattern) =>
  ["std::net", "TcpStream/TcpListener", "UdpSocket"].includes(pattern.name)
);

export function matchingPatternNames(text, patterns = runtimeNetworkPatterns) {
  return patterns.filter((pattern) => pattern.regex.test(text)).map((pattern) => pattern.name);
}

export function textWithoutApprovedSameOriginEvidenceConnect(text) {
  return text
    .replaceAll(
      /\bfetch\s*\(\s*["']\/(?:evidence|game-archive)\/append["']\s*,/gu,
      "approvedSameOriginEvidenceAppend("
    )
    .replaceAll(
      /\bfetch\s*\(\s*["']\/analyzer\/analyze["']\s*,/gu,
      "approvedSameOriginAnalyzerAnalyze("
    );
}
