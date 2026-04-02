import type { ReactNode } from "react";

type StepItemProps = {
  index: number;
  title: string;
  description: string;
  icon: ReactNode;
  isLast?: boolean;
};

export function StepItem({
  index,
  title,
  description,
  icon,
  isLast = false,
}: StepItemProps) {
  return (
    <div className="grid gap-4 rounded-[1.5rem] border border-white/[0.08] bg-white/[0.03] p-5 md:grid-cols-[auto_1fr] md:items-start md:gap-5">
      <div className="relative flex items-center gap-4 md:flex-col md:items-center">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-indigo-300/20 bg-indigo-500/10 text-indigo-100">
          {icon}
        </div>
        {!isLast ? (
          <div className="hidden h-12 w-px bg-gradient-to-b from-indigo-300/40 to-transparent md:block" />
        ) : null}
      </div>

      <div>
        <p className="text-sm font-medium uppercase tracking-[0.24em] text-slate-400">
          Step {index}
        </p>
        <h3 className="mt-2 text-xl font-semibold tracking-tight text-white">
          {title}
        </h3>
        <p className="mt-3 max-w-xl text-sm leading-7 text-slate-300">
          {description}
        </p>
      </div>
    </div>
  );
}
