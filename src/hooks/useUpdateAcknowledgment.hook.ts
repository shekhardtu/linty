import { useEffect } from "react";
import { useAppStore } from "@/store/app.store";
import { initializeUpdateHistory } from "@/services/update-acknowledgment.service";

export function useUpdateAcknowledgment() {
  const loaded = useAppStore(s => s.settingsLoaded);
  const returningCustomer = useAppStore(s => s.onboardingComplete);
  useEffect(() => {
    if (!loaded) return;
    let active = true;
    void initializeUpdateHistory(returningCustomer).then(history => {
      if (active) useAppStore.setState({ installedVersion: history.lastRunVersion, updateNotice: history.notice });
    }).catch(error => console.error("[updater] Could not remember the installed version:", error));
    return () => { active = false; };
  }, [loaded, returningCustomer]);
}
