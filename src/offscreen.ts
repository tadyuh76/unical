// A hidden page the background worker opens to read UEH while the student isn't on it: reading needs a DOM,
// which the worker doesn't have. It answers one kind of message and is closed again right after.
import type { Message, ReadResult } from "@/types";
import { readSite } from "@/ueh";

chrome.runtime.onMessage.addListener((message: Message, _sender, respond) => {
  if (message.type !== "READ") return false;
  readSite(message.site, message.plan).then(
    (result: ReadResult) => respond(result),
    () => respond(null) // network trouble: the next round tries again
  );
  return true;
});
