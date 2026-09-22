import { getGCodeCopy, type SupportedLocale, type UiLocale } from "@gcode/i18n";

export function formatCliHelp(
  version: string,
  locale?: UiLocale,
  detectedLocale?: SupportedLocale,
): string {
  return getGCodeCopy(locale, detectedLocale).cli.help(version);
}
