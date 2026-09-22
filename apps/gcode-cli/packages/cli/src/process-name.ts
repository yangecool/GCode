export const CLI_COMMAND_NAME = "gcode";
export const CLI_PROCESS_NAME = "gcode-cli";

interface ProcessTitleTarget {
  title: string;
}

export const setCliProcessTitle = (
  target: ProcessTitleTarget = process,
): void => {
  target.title = CLI_PROCESS_NAME;
};
