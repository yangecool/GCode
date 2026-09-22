import type { ApiClient } from "@gcode/shared";
import { readApiJson } from "../providers/api/apiJson.js";
import { GCODE_CLIENT_SCENES_URL } from "../providers/api/apiEndpoints.js";
import type { ClientScenesResponse, IClientScenesService } from "./clientScenes.js";

export function createClientScenesService(dependencies: {
  apiClient: ApiClient;
}): IClientScenesService {
  return {
    list: () =>
      readApiJson<ClientScenesResponse>(dependencies.apiClient, GCODE_CLIENT_SCENES_URL, {
        method: "GET",
      }),
  };
}
