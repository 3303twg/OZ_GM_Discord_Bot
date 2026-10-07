import "dotenv/config";
import {
  ActionRowBuilder,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import { getReportChannel, setReportChannel } from "./channels.js";
import { loadConfig } from "./config.js";
import {
  clockTime,
  formatSeoulNow,
  normalizeClockTime,
  normalizeMonthDay,
  seoulDayKey,
  toBulletList,
} from "./format.js";
import { buildModal } from "./modal.js";
import { displayNameKey } from "./match.js";
import { ensurePanel } from "./panel.js";
import { findReport } from "./reports.js";
import { createWorkbook } from "./sheets.js";

const config = loadConfig();
const workbook = createWorkbook(config);

const panelCommand = new SlashCommandBuilder()
  .setName("pannel")
  .setDescription("현재 채널에 보고 버튼을 올립니다.")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels);

const flushCommand = new SlashCommandBuilder()
  .setName("flush")
  .setDescription("모아 둔 캐시를 시트에 바로 기록합니다.")
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
        { name: "Close", value: "close" },
        { name: "Absent", value: "absent" },
      ),
  );

const commands = [panelCommand.toJSON(), setChannelCommand.toJSON(), flushCommand.toJSON()];
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const correctionPrompts = new Map();

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

    if (interaction.isChatInputCommand() && interaction.commandName === "flush") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await workbook.flushNow();
      if (!result.ok && result.reason === "loading") {
        await interaction.editReply("대시보드 명단을 불러오는 중입니다. 잠시 뒤 다시 시도해 주세요.");
        return;
      }
      if (!result.ok) {
        await interaction.editReply("시트 반영에 실패했습니다. 모아 둔 기록은 유지했고 잠시 뒤 다시 시도합니다.");
        return;
      }
      const dashboardText = result.dashboardWritten ? "대시보드 갱신" : "대시보드 변경 없음";
      await interaction.editReply(
        `시트에 반영했습니다. 로그 ${result.logCount}건, 불참 ${result.absenceCount}건, ${dashboardText}.`,
      );
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
      if (report.correctionChoice) {
        const select = new StringSelectMenuBuilder()
          .setCustomId("correction:type")
          .setPlaceholder("정정할 보고를 선택하세요")
          .addOptions(
            { label: "업무 보고 정정", value: "daily" },
            { label: "업무 마감 정정", value: "close" },
          );
        await interaction.reply({
          content: "정정할 보고 유형을 선택하세요.",
          components: [new ActionRowBuilder().addComponents(select)],
          flags: MessageFlags.Ephemeral,
        });
        const prompt = await interaction.fetchReply();
        const promptKey = correctionPromptKey(interaction);
        correctionPrompts.set(promptKey, {
          webhook: interaction.webhook,
          messageId: prompt.id,
        });
        setTimeout(() => correctionPrompts.delete(promptKey), 15 * 60 * 1000).unref?.();
        return;
      }
      const role = await roleFromDashboard(interaction);
      if (!role) {
        return;
      }
      await interaction.showModal(buildModal(report, role));
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === "correction:type") {
      const correctionType = interaction.values[0];
      const report = findReport("correction");
      const role = await roleFromDashboard(interaction);
      if (!role) {
        return;
      }
      await interaction.showModal(buildModal(report, role, correctionType));
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
  const [, reportId, openedAtText, correctionType] = interaction.customId.split(":");
  const report = findReport(reportId);
  const openedAt = Number(openedAtText);
  const validCorrection =
    !report?.correctionChoice || correctionType === "daily" || correctionType === "close";
  if (!report || !Number.isFinite(openedAt) || !validCorrection) {
    await interaction.reply({
      content: "알 수 없는 보고 양식입니다.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const correctionTime = report.correctionChoice
    ? normalizeClockTime(
        interaction.fields.getTextInputValue(correctionType === "daily" ? "clockIn" : "clockOut"),
      )
    : null;
  const absenceDates = report.absenceDates
    ? {
        absence: normalizeMonthDay(interaction.fields.getTextInputValue("absenceDate"), new Date(openedAt)),
        replacement: normalizeMonthDay(
          interaction.fields.getTextInputValue("replacementDate"),
          new Date(openedAt),
        ),
      }
    : null;
  const openedDate = formatSeoulNow(new Date(openedAt));
  const correctionLabel = correctionType === "daily" ? "출근시간" : "퇴근시간";
  const reportDate = report.correctionChoice
    ? `${openedDate.slice(0, 10)} ${correctionLabel} ${correctionTime ?? "-"}`
    : openedDate;
  const content = interaction.fields.getTextInputValue("content").trim();
  const nickname = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
  if (!workbook.isDashboardReady()) {
    await interaction.reply({
      content: "대시보드 명단을 불러오는 중입니다. 잠시 뒤 다시 시도해 주세요.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const role = workbook.roleForNickname(nickname);

  if (report.correctionChoice && !correctionTime) {
    await interaction.reply({
      content: `${correctionLabel}을 \`09:00\` 형식으로 입력해 주세요.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (absenceDates && (!absenceDates.absence || !absenceDates.replacement)) {
    await interaction.reply({
      content: "불참날짜와 대체업무 진행날짜를 `10.07` 형식으로 입력해 주세요.",
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

  const channelType = report.correctionChoice ? correctionType : report.channelType ?? report.id;
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
          ...(report.correctionChoice
            ? [
                {
                  name: "정정일자",
                  value: `${openedDate.slice(0, 10)}\n${correctionLabel} ${correctionTime}`,
                },
              ]
            : [{ name: "보고 일자", value: reportDate }]),
          { name: "역할", value: role },
          ...(absenceDates
            ? [
                { name: "불참날짜", value: absenceDates.absence },
                { name: "대체업무 진행날짜", value: absenceDates.replacement },
              ]
            : []),
          { name: report.outputLabel, value: toBulletList(content) },
        ),
    ],
  });

  const today = seoulDayKey().replaceAll("-", ".");
  const shouldUpdateDashboard = report.id !== "absent" || absenceDates.absence === today;
  try {
    const attendance = workbook.noteReport({
      logRow: [
        formatSeoulNow(),
        report.correctionChoice
          ? correctionType === "daily"
            ? "업무 보고 정정"
            : "업무 마감 정정"
          : report.buttonLabel,
        displayNameKey(nickname),
        role,
        content,
        message.url,
        reportDate,
        absenceDates?.absence ?? "",
        absenceDates?.replacement ?? "",
      ],
      absenceRow: absenceDates
        ? [
            formatSeoulNow(),
            displayNameKey(nickname),
            role,
            absenceDates.absence,
            absenceDates.replacement,
            content,
            message.url,
          ]
        : null,
      nickname,
      patch: shouldUpdateDashboard
        ? attendancePatch(report.id, reportDate, { type: correctionType, time: correctionTime })
        : null,
    });
    if (attendance !== "updated" && attendance !== "skipped") {
      console.warn(`대시보드 닉네임 반영 안 됨: ${nickname} (${attendance})`);
    }
  } catch (error) {
    console.error("보고 대기열 기록 실패", error);
  }
  if (report.correctionChoice) {
    await deleteCorrectionPrompt(interaction);
  }
  await interaction.deleteReply().catch(() => {});
}

async function roleFromDashboard(interaction) {
  if (!workbook.isDashboardReady()) {
    await interaction.reply({
      content: "대시보드 명단을 불러오는 중입니다. 잠시 뒤 다시 눌러 주세요.",
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }
  const nickname = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
  const role = workbook.roleForNickname(nickname);
  if (!role || !config.roles.includes(role)) {
    await interaction.reply({
      content: "대시보드에서 닉네임과 일치하는 역할을 찾지 못했습니다.",
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }
  return role;
}

function correctionPromptKey(interaction) {
  return `${interaction.guildId}:${interaction.user.id}`;
}

async function deleteCorrectionPrompt(interaction) {
  const key = correctionPromptKey(interaction);
  const prompt = correctionPrompts.get(key);
  if (!prompt) {
    return;
  }
  correctionPrompts.delete(key);
  await prompt.webhook.deleteMessage(prompt.messageId).catch((error) => {
    console.warn("정정 유형 선택 메시지를 삭제하지 못했습니다.", error.message);
  });
}

function attendancePatch(reportId, reportDate, correction = null) {
  const judgedAt = formatSeoulNow();
  const time = clockTime(reportDate);
  if (reportId === "correction") {
    return {
      ...(correction.type === "daily"
        ? { clockIn: correction.time }
        : { clockOut: correction.time }),
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
  return { status: "불참", judgedAt, absent: true };
}

async function replyError(interaction, content) {
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
}

await client.login(config.token);
