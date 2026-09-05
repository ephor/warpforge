import LanguageServersPanel from "@/components/LanguageServersPanel";
import TrackersPanel from "@/components/TrackersPanel";

import { Section } from "../primitives";

export default function IntegrationsPage() {
  return (
    <div className="flex flex-col gap-8">
      <Section title="Language servers">
        <div className="p-4">
          <LanguageServersPanel />
        </div>
      </Section>

      <Section title="Issue trackers">
        <div className="p-4">
          <TrackersPanel />
        </div>
      </Section>
    </div>
  );
}
