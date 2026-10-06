import {
  LabelBuilder,
  ModalBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { formatSeoulNow } from "./format.js";

export function buildModal(report, role) {
  const openedAt = Date.now();
  const currentDate = formatSeoulNow(new Date(openedAt));
  const dateComponents = report.correctionTimes
    ? [
        new LabelBuilder().setLabel("출근시간").setTextInputComponent(
          new TextInputBuilder()
            .setCustomId("clockIn")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMinLength(4)
            .setMaxLength(5)
            .setPlaceholder("09:00"),
        ),
        new LabelBuilder().setLabel("퇴근시간").setTextInputComponent(
          new TextInputBuilder()
            .setCustomId("clockOut")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMinLength(4)
            .setMaxLength(5)
            .setPlaceholder("18:00"),
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
    .setCustomId(`modal:${report.id}:${openedAt}`)
    .setTitle(report.modalTitle)
    .addComponents(...dateComponents, roleDisplay, content);
}
