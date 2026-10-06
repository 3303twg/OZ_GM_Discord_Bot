import "dotenv/config";
import {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { getReportChannel, setReportChannel } from "./channels.js";
import { loadConfig } from "./config.js";
import { clockTime, formatSeoulNow, normalizeClockTime, toBulletList } from "./format.js";
import { buildModal } from "./modal.js";
import { ensurePanel } from "./panel.js";
import { findReport } from "./reports.js";
import { createWorkbook } from "./sheets.js";

const config = loadConfig();
const workbook = createWorkbook(config);

const panelCommand = new SlashCommandBuilder()
  .setName("pannel")
  .setDescription("현재 채널에 보고 버튼을 올립니다.")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels);

const setChannelCommand = new SlashCommandBuilder()
  .setName("setchannel")
  .setDescription("현재 채널을 보고 결과 채널로 설정합니다.")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .addStringOption((option) =>
    option
      .setName("type")
      .setDescription("이 채널에서 받을 보고 종류")
      .setRequired(true)
      .addChoices(
        { name: "Daily", value: "daily" },
        { name: "Correction", value: "correction" },
        { name: "Close", value: "close" },
        { name: "Absent", value: "absent" },
      ),
  );

const commands = [panelCommand.toJSON(), setChannelCommand.toJSON()];
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`로그인: ${readyClient.user.tag}`);
  for (const guild of readyClient.guilds.cache.values()) {
    await registerCommands(guild);
  }
  workbook.startDayWatcher();
});

client.on(Events.GuildCreate, registerCommands);

async function registerCommands(guild) {
  try {
    await guild.commands.set(commands);
    console.log(`명령 등록: ${guild.name}`);
  } catch (error) {
    console.error(`명령 등록 실패: ${guild.name}`, error);
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === "pannel") {
      await ensurePanel(interaction.client, interaction.channelId);
      await interaction.reply({
        content: "현재 채널에 보고 버튼을 올렸습니다.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === "setchannel") {
      const type = interaction.options.getString("type", true);
      setReportChannel(type, interaction.channelId);
      await interaction.reply({
        content: `${type} 보고 채널을 <#${interaction.channelId}>로 설정했습니다.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("report:")) {
      const report = findReport(interaction.customId.slice("report:".length));
      if (!report) {
        await interaction.reply({
          content: "이 버튼은 더 이상 쓸 수 없습니다. `/pannel`로 버튼을 다시 올려 주세요.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const nickname =
        interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
      let role = workbook.roleForNickname(nickname);
      if (!role) {
        role = await workbook.refreshRoleForNickname(nickname);
      }
      if (!role || !config.roles.includes(role)) {
        await interaction.reply({
          content: "대시보드에서 닉네임과 일치하는 역할을 찾지 못했습니다.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.showModal(buildModal(report, role));
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("modal:")) {
      await submitReport(interaction);
    }
  } catch (error) {
    console.error(error);
    await replyError(interaction, "처리 중 오류가 났습니다. 잠시 뒤 다시 시도해 주세요.");
  }
});

async function submitReport(interaction) {
  const [, reportId, openedAtText] = interaction.customId.split(":");
  const report = findReport(reportId);
  const openedAt = Number(openedAtText);
  if (!report || !Number.isFinite(openedAt)) {
    await interaction.reply({
      content: "알 수 없는 보고 양식입니다.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const correctionTimes = report.correctionTimes
    ? {
        clockIn: normalizeClockTime(interaction.fields.getTextInputValue("clockIn")),
        clockOut: normalizeClockTime(interaction.fields.getTextInputValue("clockOut")),
      }
    : null;
  const openedDate = formatSeoulNow(new Date(openedAt));
  const reportDate = correctionTimes
    ? `${openedDate.slice(0, 10)} 출근 ${correctionTimes.clockIn ?? "-"} / 퇴근 ${correctionTimes.clockOut ?? "-"}`
    : openedDate;
  const content = interaction.fields.getTextInputValue("content").trim();
  const nickname = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
  const role = workbook.roleForNickname(nickname);

  if (correctionTimes && (!correctionTimes.clockIn || !correctionTimes.clockOut)) {
    await interaction.reply({
      content: "출근시간과 퇴근시간을 `09:00`, `18:00` 형식으로 입력해 주세요.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!role || !config.roles.includes(role)) {
    await interaction.reply({
      content: "대시보드에서 닉네임과 일치하는 역할을 찾지 못했습니다.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!content) {
    await interaction.reply({
      content: "내용을 입력해 주세요.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const channelType = report.channelType ?? report.id;
  const channelId = getReportChannel(channelType);
  if (!channelId) {
    await interaction.editReply(`/setchannel 명령으로 ${channelType} 채널을 먼저 설정해 주세요.`);
    return;
  }
  const channel = await interaction.client.channels.fetch(channelId);
  if (!channel?.isTextBased()) {
    await interaction.editReply("결과를 올릴 채널을 찾지 못했습니다. 채널 ID 설정을 확인해 주세요.");
    return;
  }

  const message = await channel.send({
    content: `<@${interaction.user.id}>`,
    allowedMentions: { users: [interaction.user.id] },
    embeds: [
      new EmbedBuilder()
        .setColor(0x2b2d31)
        .addFields(
          ...(correctionTimes
            ? [
                {
                  name: "정정일자",
                  value: `${openedDate.slice(0, 10)}\n${correctionTimes.clockIn} ~ ${correctionTimes.clockOut}`,
                },
              ]
            : [{ name: "보고 일자", value: reportDate }]),
          { name: "역할", value: role },
          { name: report.outputLabel, value: toBulletList(content) },
        ),
    ],
  });

  try {
    await workbook.appendLog([
      formatSeoulNow(),
      report.buttonLabel,
      nickname,
      role,
      content,
      message.url,
      reportDate,
    ]);
  } catch (error) {
    console.error("시트 기록 실패", error);
    await interaction.deleteReply().catch(() => {});
    return;
  }

  try {
    const attendance = await workbook.recordAttendance(
      nickname,
      attendancePatch(report.id, reportDate, correctionTimes),
    );
    if (attendance !== "updated") {
      console.warn(`대시보드 닉네임 반영 안 됨: ${nickname} (${attendance})`);
    }
  } catch (error) {
    console.error("대시보드 반영 실패", error);
  }
  await interaction.deleteReply().catch(() => {});
}

function attendancePatch(reportId, reportDate, correctionTimes = null) {
  const judgedAt = formatSeoulNow();
  const time = clockTime(reportDate);
  if (reportId === "correction") {
    return {
      clockIn: correctionTimes.clockIn,
      clockOut: correctionTimes.clockOut,
      judgedAt,
      corrected: true,
    };
  }
  if (reportId === "daily") {
    return { status: "근무중", clockIn: time, judgedAt };
  }
  if (reportId === "close") {
    return { status: "퇴근", clockOut: time, judgedAt };
  }
  return { status: "불참", judgedAt };
}

async function replyError(interaction, content) {
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
}

await client.login(config.token);
