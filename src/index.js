import "./log.js";
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
import { loadConfig } from "./config.js";
import {
  ensureGuild,
  getGuildChannel,
  guildSheetsReady,
  missingGuildSettings,
  describeGuildSettings,
  parseSheetLink,
  readGuild,
  rosterIndexes,
  setGuildChannel,
  setGuildRoster,
  setGuildSheet,
} from "./guilds.js";
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
const workbooks = new Map();

const panelCommand = new SlashCommandBuilder()
  .setName("pannel")
  .setDescription("현재 채널에 보고 버튼을 올립니다.")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels);

const reloadCommand = new SlashCommandBuilder()
  .setName("reload")
  .setDescription("원본 명단을 다시 읽어 대시보드 인원을 갱신합니다.")
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

const setSheetCommand = new SlashCommandBuilder()
  .setName("setsheet")
  .setDescription("이 서버가 사용할 시트 링크를 저장합니다.")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .addStringOption((option) =>
    option
      .setName("type")
      .setDescription("저장할 시트")
      .setRequired(true)
      .addChoices(
        { name: "대시보드", value: "dashboard" },
        { name: "보고로그", value: "log" },
        { name: "업무불참", value: "absent" },
        { name: "명단", value: "roster" },
        { name: "리뷰어작업", value: "task" },
      ),
  )
  .addStringOption((option) =>
    option.setName("link").setDescription("열려 있는 탭의 구글 시트 주소").setRequired(true),
  );

const setRosterCommand = new SlashCommandBuilder()
  .setName("setroster")
  .setDescription("명단 시트에서 이름, 직무, 근무상태를 읽을 열을 저장합니다.")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .addIntegerOption((option) => option.setName("name").setDescription("이름 열 번호. A열은 1").setRequired(true).setMinValue(1))
  .addIntegerOption((option) => option.setName("job").setDescription("직무 열 번호. A열은 1").setRequired(true).setMinValue(1))
  .addIntegerOption((option) =>
    option.setName("status").setDescription("근무상태 열 번호. A열은 1").setRequired(true).setMinValue(1),
  )
  .addIntegerOption((option) =>
    option.setName("header").setDescription("헤더 행 번호. 비우면 10").setRequired(false).setMinValue(1),
  )
  .addStringOption((option) =>
    option.setName("active").setDescription("대시보드에 넣을 근무상태 값. 비우면 근무중").setRequired(false),
  );

const settingsCommand = new SlashCommandBuilder()
  .setName("settings")
  .setDescription("이 서버의 시트와 채널 설정을 보여 줍니다.")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels);

const commands = [
  panelCommand.toJSON(),
  setChannelCommand.toJSON(),
  setSheetCommand.toJSON(),
  settingsCommand.toJSON(),
  setRosterCommand.toJSON(),
  flushCommand.toJSON(),
  reloadCommand.toJSON(),
];
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const correctionPrompts = new Map();

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`로그인: ${readyClient.user.tag}`);
  for (const guild of readyClient.guilds.cache.values()) {
    startGuild(guild.id);
    await registerCommands(guild);
  }
});

client.on(Events.GuildCreate, async (guild) => {
  startGuild(guild.id);
  await registerCommands(guild);
});

async function registerCommands(guild) {
  try {
    await guild.commands.set(commands);
    console.log(`명령 등록: ${guild.name}`);
  } catch (error) {
    console.error(`명령 등록 실패: ${guild.name}`, error);
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  const actor = actorLabel(interaction);
  const attempt = attemptLabel(interaction);
  console.log(`시도: ${actor} ${attempt}`);
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === "pannel") {
      if (!interaction.guildId) {
        await interaction.reply({ content: "서버 안에서 실행해 주세요.", flags: MessageFlags.Ephemeral });
        return;
      }
      await ensurePanel(interaction.client, interaction.channelId, interaction.guildId, config);
      await interaction.reply({
        content: "현재 채널에 보고 버튼을 올렸습니다.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === "reload") {
      const workbook = workbookFor(interaction);
      if (!workbook) {
        await interaction.reply({
          content: missingSettingsMessage(interaction.guildId),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await workbook.reloadRoster();
      if (!result.ok && !result.tasksOk) {
        await interaction.editReply("원본 명단과 리뷰어 작업 현황을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
        return;
      }
      if (!result.ok) {
        await interaction.editReply("원본 명단을 불러오지 못했습니다. 리뷰어 작업 현황은 다시 읽었습니다.");
        return;
      }
      if (!result.tasksOk) {
        await interaction.editReply(
          `원본 명단을 대시보드에 반영했습니다. 현재 ${result.count}명입니다. 리뷰어 작업 현황은 불러오지 못했습니다.`,
        );
        return;
      }
      await interaction.editReply(
        `원본 명단을 대시보드에 반영했습니다. 현재 ${result.count}명입니다. 리뷰어 작업 현황도 다시 읽었습니다.`,
      );
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === "flush") {
      const workbook = workbookFor(interaction);
      if (!workbook) {
        await interaction.reply({
          content: missingSettingsMessage(interaction.guildId),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
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
      if (!interaction.guildId) {
        await interaction.reply({ content: "서버 안에서 실행해 주세요.", flags: MessageFlags.Ephemeral });
        return;
      }
      const type = interaction.options.getString("type", true);
      setGuildChannel(interaction.guildId, config, type, interaction.channelId);
      await interaction.reply({
        content: `${type} 보고 채널을 <#${interaction.channelId}>로 설정했습니다.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === "settings") {
      if (!interaction.guildId) {
        await interaction.reply({ content: "서버 안에서 실행해 주세요.", flags: MessageFlags.Ephemeral });
        return;
      }
      const settings = readGuild(interaction.guildId, config);
      await interaction.reply({
        content: describeGuildSettings(settings),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === "setsheet") {
      if (!interaction.guildId) {
        await interaction.reply({ content: "서버 안에서 실행해 주세요.", flags: MessageFlags.Ephemeral });
        return;
      }
      const type = interaction.options.getString("type", true);
      const link = interaction.options.getString("link", true);
      const saved = setGuildSheet(interaction.guildId, config, type, link);
      if (!saved) {
        await interaction.reply({
          content: "시트 주소를 읽지 못했습니다. 탭이 열린 주소에 gid= 번호가 있어야 합니다.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      resetWorkbook(interaction.guildId);
      const parsed = parseSheetLink(link);
      await interaction.reply({
        content: `${sheetTypeLabel(type)} 시트를 이 서버 설정에 넣었습니다. 탭 번호는 ${parsed.sheetId}입니다.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === "setroster") {
      if (!interaction.guildId) {
        await interaction.reply({ content: "서버 안에서 실행해 주세요.", flags: MessageFlags.Ephemeral });
        return;
      }
      const saved = setGuildRoster(interaction.guildId, config, {
        nameColumn: interaction.options.getInteger("name", true),
        jobColumn: interaction.options.getInteger("job", true),
        statusColumn: interaction.options.getInteger("status", true),
        headerRow: interaction.options.getInteger("header") ?? 10,
        activeStatus: interaction.options.getString("active") || "근무중",
      });
      resetWorkbook(interaction.guildId);
      await interaction.reply({
        content: `명단은 ${saved.roster.headerRow}행 헤더에서 이름 ${saved.roster.nameColumn}열, 직무 ${saved.roster.jobColumn}열, 근무상태 ${saved.roster.statusColumn}열을 읽습니다. 넣을 값은 ${saved.roster.activeStatus}입니다.`,
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
    console.error(`실패: ${actor} ${attempt}`, error);
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
  const workbook = workbookFor(interaction);
  if (!workbook) {
    await interaction.reply({
      content: missingSettingsMessage(interaction.guildId),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
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
  if (!role) {
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
  const missing = missingSettingsMessage(interaction.guildId, channelType);
  if (missing) {
    await interaction.editReply(missing);
    return;
  }
  const channelId = getGuildChannel(interaction.guildId, channelType);
  const channel = await interaction.client.channels.fetch(channelId);
  if (!channel?.isTextBased()) {
    await interaction.editReply("결과를 올릴 채널을 찾지 못했습니다. 채널 ID 설정을 확인해 주세요.");
    return;
  }
  if (report.id === "close" && config.roles.includes(role)) {
    const task = await workbook.checkReviewerClose(nickname);
    if (task === "block") {
      await interaction.editReply(
        "일일 수행해야 하는 Task가 남아 있어 마감 보고를 할 수 없습니다.\n금일 진행한 Task 리뷰 제출을 완료해주시기 바랍니다.",
      );
      return;
    }
    if (task === "retry") {
      await interaction.editReply("데이터 갱신중입니다. 1분 후에 다시 시도해 주세요.");
      return;
    }
    if (task === "missing") {
      await interaction.editReply("마감 가능 여부를 확인하지 못했습니다. 관리자에게 문의해 주세요.");
      return;
    }
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
    console.error(`보고 대기열 기록 실패: ${nickname}`, error);
  }
  if (report.correctionChoice) {
    await deleteCorrectionPrompt(interaction);
  }
  await interaction.deleteReply().catch(() => {});
}

async function roleFromDashboard(interaction) {
  const workbook = workbookFor(interaction);
  if (!workbook) {
    await interaction.reply({
      content: missingSettingsMessage(interaction.guildId),
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }
  if (!workbook.isDashboardReady()) {
    await interaction.reply({
      content: "대시보드 명단을 불러오는 중입니다. 잠시 뒤 다시 눌러 주세요.",
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }
  const nickname = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
  const role = workbook.roleForNickname(nickname);
  if (!role) {
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

function actorLabel(interaction) {
  const name = interaction.member?.displayName || interaction.user?.globalName || interaction.user?.username || "알 수 없음";
  const guild = interaction.guild?.name ?? "개인 메시지";
  return `${name} (${interaction.user?.id ?? "-"}) @${guild}`;
}

function attemptLabel(interaction) {
  if (interaction.isChatInputCommand()) {
    const options = interaction.options.data.map((option) => `${option.name}=${option.value}`).join(" ");
    return `/${interaction.commandName}${options ? ` ${options}` : ""}`;
  }
  if (interaction.isButton() && interaction.customId.startsWith("report:")) {
    const report = findReport(interaction.customId.slice("report:".length));
    return report?.buttonLabel ?? interaction.customId;
  }
  if (interaction.isStringSelectMenu() && interaction.customId === "correction:type") {
    return interaction.values[0] === "daily" ? "업무 보고 정정 선택" : "업무 마감 정정 선택";
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith("modal:")) {
    const [, reportId, , correctionType] = interaction.customId.split(":");
    const report = findReport(reportId);
    if (report?.correctionChoice) {
      return correctionType === "daily" ? "업무 보고 정정 전송" : "업무 마감 정정 전송";
    }
    return `${report?.buttonLabel ?? "보고"} 전송`;
  }
  return interaction.customId || "상호작용";
}

function startGuild(guildId) {
  ensureGuild(guildId, config);
  workbookFor({ guildId });
}

function workbookFor(interaction) {
  const guildId = interaction.guildId;
  if (!guildId) {
    return null;
  }
  const settings = ensureGuild(guildId, config);
  if (!guildSheetsReady(settings)) {
    return null;
  }
  const existing = workbooks.get(guildId);
  if (existing) {
    return existing;
  }
  const workbook = createWorkbook({
    ...config,
    guildId,
    spreadsheetId: settings.sheets.logSpreadsheetId,
    logSheetId: Number(settings.sheets.logSheetId),
    dashboardSpreadsheetId: settings.sheets.dashboardSpreadsheetId,
    dashboardSheetId: Number(settings.sheets.dashboardSheetId),
    absenceSpreadsheetId: settings.sheets.absenceSpreadsheetId,
    absenceSheetId:
      settings.sheets.absenceSheetId == null || settings.sheets.absenceSheetId === ""
        ? null
        : Number(settings.sheets.absenceSheetId),
    rosterSpreadsheetId: settings.sheets.rosterSpreadsheetId,
    rosterSheetId: Number(settings.sheets.rosterSheetId),
    taskSpreadsheetId: settings.sheets.taskSpreadsheetId,
    taskSheetId: Number(settings.sheets.taskSheetId),
    roster: rosterIndexes(settings.roster),
    roles: settings.roles,
  });
  workbook.stop = workbook.startDayWatcher();
  workbooks.set(guildId, workbook);
  return workbook;
}

function resetWorkbook(guildId) {
  const existing = workbooks.get(guildId);
  existing?.stop?.();
  workbooks.delete(guildId);
  return workbookFor({ guildId });
}

function sheetTypeLabel(type) {
  return {
    dashboard: "대시보드",
    log: "보고로그",
    absent: "업무불참",
    roster: "명단",
    task: "리뷰어 작업",
  }[type];
}

function missingSettingsMessage(guildId, channelType) {
  if (!guildId) {
    return "서버 안에서 실행해 주세요.";
  }
  const missing = missingGuildSettings(readGuild(guildId, config), { channelType });
  if (missing.length === 0) {
    return null;
  }
  return `없는 설정: ${missing.join(", ")}. /settings 에서 확인하고 /setsheet, /setroster, /setchannel 로 넣어 주세요.`;
}

await client.login(config.token);
