const dns = require("node:dns");

const entries = new Map();
for (const item of String(process.env.TOKENPILOT_UPSTREAM_DNS_OVERRIDE || "").split(",")) {
  const [hostname, address] = item.split("=", 2).map((value) => value.trim());
  if (hostname && address) entries.set(hostname.toLowerCase(), address);
}

if (entries.size > 0) {
  const originalLookup = dns.lookup.bind(dns);
  dns.lookup = (hostname, options, callback) => {
    if (typeof options === "function") {
      callback = options;
      options = {};
    } else if (typeof options === "number") {
      options = { family: options };
    } else {
      options = options || {};
    }

    const address = entries.get(String(hostname).toLowerCase());
    if (!address) return originalLookup(hostname, options, callback);

    const family = address.includes(":") ? 6 : 4;
    process.nextTick(() => {
      if (options.all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    });
  };
}
