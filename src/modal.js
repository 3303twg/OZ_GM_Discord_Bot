import {
  LabelBuilder,
  ModalBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { formatSeoulNow } from "./format.js";

export function buildModal(report, role, correctionType = null) {
  const openedAt = Date.now();
  const currentDate = formatSeoulNow(new Date(openedAt));
  const dateComponents = report.correctionChoice
    ? [
        new LabelBuilder()
          .setLabel(correctionType === "daily" ? "출근시간" : "퇴근시간")
          .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(correctionType === "daily" ? "clockIn" : "clockOut")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMinLength(4)
            .setMaxLength(5)
            .setPlaceholder(correctionType === "daily" ? "09:00" : "18:00"),
          ),
      ]
    : [
        new TextDisplayBuilder().setContent(
          `**보고 일자**\n\`\`\`\n${currentDate}\n\`\`\``,
        ),
      ];

  const roleDisplay = new TextDisplayBuilder().setContent(
    `**역할**\n\`\`\`\n${role}\n\`\`\``,
  );

  const absenceDateComponents = report.absenceDates
    ? [
        new LabelBuilder().setLabel("불참날짜").setTextInputComponent(
          new TextInputBuilder()
            .setCustomId("absenceDate")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMinLength(3)
            .setMaxLength(8)
            .setPlaceholder("10.07"),
        ),
        new LabelBuilder().setLabel("대체업무 진행날짜").setTextInputComponent(
          new TextInputBuilder()
            .setCustomId("replacementDate")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMinLength(3)
            .setMaxLength(8)
            .setPlaceholder("10.08"),
        ),
      ]
    : [];

  const content = new LabelBuilder().setLabel(report.contentLabel).setTextInputComponent(
    new TextInputBuilder()
      .setCustomId("content")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(1000)
      .setPlaceholder(report.contentPlaceholder),
  );

  return new ModalBuilder()
    .setCustomId(`modal:${report.id}:${openedAt}${correctionType ? `:${correctionType}` : ""}`)
    .setTitle(report.modalTitle)
    .addComponents(...dateComponents, roleDisplay, ...absenceDateComponents, content);
}
