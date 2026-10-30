// Gives an unpacked build the Chrome Web Store extension ID, so Google sign-in
// (registered for that ID) also works while developing. Store uploads skip this.
import { readFileSync, writeFileSync } from "fs";

const KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsseCwVfZbVv3Q3ZV1JExPwINiXrUxXcjUMctKCOrWHMfm229ReOZa8FiAWmlyolM1djIG+A3NYpMquN4xykMuetNqlr4bobMI9pUN/SGAVVnagMoAqOIVncGp2lpcRtOCjP1AzwgELLCHLVn4KVpREV1oEIHrGhjuLYgASC/thxhbC60iIC9BNYlm8qLUbNZT3+/MHcn9NObhMsZPVOTs/kbIVOfKvhVpdfo1Mu8xFlPFBwhYDHSB3Kn4rEhOH4P2zMr2+/TVdqaqZC23mD7MdKBRH1xGWi/qCJX7Rrq0kByT3TRn9fst6hYs1T22G8KC/AEMTI7n3G9R2qG9vAlNwIDAQAB";

const path = new URL("../build/manifest.json", import.meta.url);
const manifest = JSON.parse(readFileSync(path, "utf8"));
writeFileSync(path, JSON.stringify({ ...manifest, key: KEY }, null, 2));
