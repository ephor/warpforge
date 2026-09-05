import LanguageServersPanel from "@/components/LanguageServersPanel";
import TrackersPanel from "@/components/TrackersPanel";

import { Section } from "../primitives";

export default function IntegrationsPage() {
  return (
    <div className="flex flex-col gap-8">
      <Section title="Language servers">
        <LanguageServersPanel />
      </Section>

      <Section title="Issue trackers" padded>
        <TrackersPanel />
      </Section>
    </div>
  );
}
