import fs from "node:fs";
import path from "node:path";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { REPORTS } from "./reports.js";

const panelFile = path.resolve("data/panel.json");

export function panelPayload() {
  const rows = REPORTS.map((report) =>
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`report:${report.id}`)
        .setLabel(report.buttonLabel)
        .setStyle(
          report.id === "absent"
            ? ButtonStyle.Danger
            : report.id === "correction"
              ? ButtonStyle.Secondary
              : ButtonStyle.Primary,
        ),
    ),
  );

  return {
    content: "아래의 항목 중 원하는 작업을 선택해주세요.",
    components: rows,
  };
}

function readPanelId() {
  if (!fs.existsSync(panelFile)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(panelFile, "utf8"));
}

function writePanelId(channelId, messageId) {
  fs.mkdirSync(path.dirname(panelFile), { recursive: true });
  fs.writeFileSync(panelFile, JSON.stringify({ channelId, messageId }, null, 2));
}

export async function ensurePanel(client, panelChannelId) {
  const channel = await client.channels.fetch(panelChannelId);
  if (!channel?.isTextBased()) {
    throw new Error("현재 채널에 메시지를 보낼 수 없습니다.");
  }

  const payload = panelPayload();
  const saved = readPanelId();
  if (saved?.channelId === panelChannelId && saved.messageId) {
    try {
      const message = await channel.messages.fetch(saved.messageId);
      await message.edit(payload);
      return message;
    } catch (error) {
      console.warn("기존 버튼 메시지를 찾지 못해 새로 올립니다.", error.message);
    }
  }

  const message = await channel.send(payload);
  writePanelId(panelChannelId, message.id);
  return message;
}
