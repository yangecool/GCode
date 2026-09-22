import { useGCodeStoreWithDefault } from "@/store/StoreProvider.js";

export function useIsOfficeMode(): boolean {
  return useGCodeStoreWithDefault((state) => state.interfaceMode === "office", false);
}
