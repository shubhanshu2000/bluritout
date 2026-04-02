import type { ReactNode } from "react";

type FeatureCardProps = {
  icon: ReactNode;
  title: string;
  description: string;
};

export function FeatureCard({ icon, title, description }: FeatureCardProps) {
  return (
    <article className="group h-full rounded-[1.75rem] border border-white/[0.08] bg-white/[0.03] p-6 shadow-[0_18px_50px_rgba(0,0,0,0.18)] backdrop-blur-sm transition duration-300 hover:-translate-y-1 hover:border-indigo-300/20 hover:bg-white/[0.05]">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-indigo-300/20 bg-indigo-500/10 text-indigo-200 transition duration-300 group-hover:border-indigo-300/30 group-hover:bg-indigo-500/15">
        {icon}
      </div>
      <h3 className="mt-6 text-xl font-semibold tracking-tight text-white">
        {title}
      </h3>
      <p className="mt-3 text-sm leading-7 text-slate-300">{description}</p>
    </article>
  );
}
