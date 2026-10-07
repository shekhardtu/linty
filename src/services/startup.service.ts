import { invoke } from "@tauri-apps/api/core";
import type { StartupSettings } from "@/types/startup.types";

export const getStartupSettings = () => invoke<StartupSettings>("get_startup_settings");
export const setLaunchAtLogin = (enabled: boolean) => invoke<StartupSettings>("set_launch_at_login", { enabled });
export const finishStartupSetup = (enabled: boolean) => invoke<StartupSettings>("finish_startup_setup", { enabled });
export const openLoginItemsSettings = () => invoke<void>("open_login_items_settings");
