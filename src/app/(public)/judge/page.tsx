import { Column } from "@/components/layout/Column";
import { JudgeAccessForm } from "@/components/judge/JudgeAccessForm";
import { copy } from "@/lib/shared/copy";

/**
 * B. Judge access, docs/01-user-flow.md section B.
 * A single centered field on warm black. No marketing.
 */
export default function JudgePage() {
  return (
    <main className="flex min-h-[70vh] items-center py-12">
      <Column className="flex flex-col gap-8">
        <div className="flex flex-col gap-4">
          <h1 className="font-display text-display-2 font-light text-text">
            {copy.judge.title}
          </h1>
          <p className="max-w-[64ch] font-body text-body text-text-muted">
            {copy.judge.body}
          </p>
        </div>
        <JudgeAccessForm />
      </Column>
    </main>
  );
}
