import fs from "node:fs";
import path from "node:path";

const channelsFile = path.resolve("data/channels.json");
const allowedTypes = new Set(["daily", "close", "absent"]);

function readChannels() {
  if (!fs.existsSync(channelsFile)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(channelsFile, "utf8"));
}

export function getReportChannel(type) {
  if (!allowedTypes.has(type)) {
    return null;
  }
  return readChannels()[type] ?? null;
}

export function setReportChannel(type, channelId) {
  if (!allowedTypes.has(type)) {
    throw new Error(`알 수 없는 채널 종류입니다: ${type}`);
  }
  const channels = readChannels();
  channels[type] = channelId;
  fs.mkdirSync(path.dirname(channelsFile), { recursive: true });
  fs.writeFileSync(channelsFile, JSON.stringify(channels, null, 2));
}
