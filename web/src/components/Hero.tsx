import { Button } from "./Button";
import { DownloadIcon, PlayIcon } from "./icons";

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,_rgba(59,130,246,0.12),_transparent_30%),radial-gradient(circle_at_80%_0%,_rgba(99,102,241,0.22),_transparent_24%)]" />
      <div className="mx-auto grid min-h-[calc(100svh-5rem)] max-w-7xl gap-14 px-6 pb-20 pt-12 sm:px-8 lg:grid-cols-[0.92fr_1.08fr] lg:items-center lg:px-12 lg:pb-24 lg:pt-10">
        <div className="relative z-10 max-w-2xl self-center">
          <div className="animate-[fade-up_700ms_ease-out_both]">
            <span className="inline-flex rounded-full border border-white/10 bg-white/5 px-4 py-1 text-sm font-medium text-slate-200">
              Built for creators who publish fast
            </span>
            <p className="mt-8 text-sm font-semibold uppercase tracking-[0.28em] text-indigo-200/90">
              BluritOut
            </p>
            <h1 className="mt-5 max-w-xl text-5xl font-semibold tracking-[-0.04em] text-white sm:text-6xl lg:text-7xl">
              Automatically Blur Faces in Your Videos
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-8 text-slate-300 sm:text-xl">
              Protect privacy with AI-powered face and number plate blurring.
            </p>
          </div>

          <div className="mt-10 flex flex-col gap-3 sm:flex-row animate-[fade-up_900ms_ease-out_both]">
            <Button href="#download" size="lg">
              <DownloadIcon className="h-5 w-5" />
              Download for Windows
            </Button>
            <Button href="#demo" variant="secondary" size="lg">
              <PlayIcon className="h-5 w-5" />
              Watch Demo
            </Button>
          </div>

          <div className="mt-10 grid max-w-lg grid-cols-2 gap-4 text-sm text-slate-300 sm:grid-cols-3 animate-[fade-up_1100ms_ease-out_both]">
            <div>
              <p className="text-2xl font-semibold tracking-tight text-white">
                Local
              </p>
              <p className="mt-1">No cloud upload required</p>
            </div>
            <div>
              <p className="text-2xl font-semibold tracking-tight text-white">
                GPU
              </p>
              <p className="mt-1">Optimized for faster renders</p>
            </div>
            <div className="col-span-2 sm:col-span-1">
              <p className="text-2xl font-semibold tracking-tight text-white">
                Precise
              </p>
              <p className="mt-1">Control who stays visible</p>
            </div>
          </div>
        </div>

        <div className="relative flex items-center justify-center animate-[float-in_900ms_ease-out_both]">
          <div className="absolute inset-x-12 top-16 h-56 rounded-full bg-indigo-500/20 blur-3xl sm:h-64" />
          <div className="absolute inset-x-16 bottom-8 h-40 rounded-full bg-cyan-400/[0.12] blur-3xl" />

          <div className="relative w-full max-w-2xl overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950/75 shadow-[0_40px_90px_rgba(0,0,0,0.45)] backdrop-blur">
            <div className="flex items-center justify-between border-b border-white/[0.08] px-5 py-4">
              <div className="flex items-center gap-3">
                <div className="flex gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-rose-400/80" />
                  <span className="h-2.5 w-2.5 rounded-full bg-amber-300/80" />
                  <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/80" />
                </div>
                <p className="text-sm font-medium text-slate-200">BluritOut Desktop</p>
              </div>
              <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300">
                Live Preview
              </div>
            </div>

            <div className="grid gap-4 p-4 sm:p-6">
              <div className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
                <div className="rounded-[1.6rem] border border-white/10 bg-[linear-gradient(180deg,_rgba(30,41,59,0.92),_rgba(15,23,42,0.96))] p-4 sm:p-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-medium uppercase tracking-[0.24em] text-slate-400">
                        Frame Review
                      </p>
                      <p className="mt-2 text-lg font-semibold text-white">
                        Privacy checks before export
                      </p>
                    </div>
                    <div className="rounded-full border border-indigo-300/20 bg-indigo-500/10 px-3 py-1 text-xs text-indigo-200">
                      1080p
                    </div>
                  </div>

                  <div className="relative mt-5 aspect-[4/3] overflow-hidden rounded-[1.4rem] bg-[linear-gradient(180deg,_rgba(71,85,105,0.42),_rgba(15,23,42,0.95))]">
                    <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_20%,_rgba(255,255,255,0.08),_transparent_40%)]" />
                    <div className="absolute left-[14%] top-[16%] h-24 w-24 rounded-full border border-cyan-300/70 bg-cyan-300/10 sm:h-28 sm:w-28" />
                    <div className="absolute left-[48%] top-[24%] h-20 w-20 rounded-full border border-indigo-300/70 bg-indigo-300/[0.12] sm:h-24 sm:w-24" />
                    <div className="absolute left-[68%] top-[52%] h-16 w-16 rounded-full border border-cyan-300/70 bg-cyan-300/10 sm:h-20 sm:w-20" />
                    <div className="absolute bottom-[18%] left-[18%] h-8 w-28 rounded-xl border border-cyan-300/70 bg-cyan-300/10" />
                    <div className="absolute bottom-4 left-4 right-4 flex items-center justify-between rounded-full border border-white/10 bg-slate-950/65 px-4 py-3 text-xs text-slate-300 backdrop-blur">
                      <span>Detected: 3 faces, 1 plate</span>
                      <span className="text-indigo-200">Frame 184</span>
                    </div>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="rounded-[1.6rem] border border-white/10 bg-white/[0.04] p-5">
                    <p className="text-xs font-medium uppercase tracking-[0.24em] text-slate-400">
                      Controls
                    </p>
                    <div className="mt-4 space-y-3">
                      <div className="flex items-center justify-between rounded-2xl border border-white/[0.08] bg-slate-950/60 px-4 py-3">
                        <span className="text-sm text-white">Keep speaker visible</span>
                        <span className="h-6 w-11 rounded-full bg-emerald-500/80 p-1">
                          <span className="block h-4 w-4 translate-x-5 rounded-full bg-white" />
                        </span>
                      </div>
                      <div className="flex items-center justify-between rounded-2xl border border-white/[0.08] bg-slate-950/60 px-4 py-3">
                        <span className="text-sm text-white">Blur bystanders</span>
                        <span className="h-6 w-11 rounded-full bg-indigo-500/90 p-1">
                          <span className="block h-4 w-4 translate-x-5 rounded-full bg-white" />
                        </span>
                      </div>
                      <div className="flex items-center justify-between rounded-2xl border border-white/[0.08] bg-slate-950/60 px-4 py-3">
                        <span className="text-sm text-white">Blur number plates</span>
                        <span className="h-6 w-11 rounded-full bg-indigo-500/90 p-1">
                          <span className="block h-4 w-4 translate-x-5 rounded-full bg-white" />
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-[1.6rem] border border-indigo-300/20 bg-[linear-gradient(180deg,_rgba(79,70,229,0.16),_rgba(15,23,42,0.7))] p-5">
                    <p className="text-xs font-medium uppercase tracking-[0.24em] text-indigo-200/90">
                      Export Queue
                    </p>
                    <div className="mt-4 space-y-4">
                      <div>
                        <div className="flex items-center justify-between text-sm text-slate-200">
                          <span>Interview-cut.mp4</span>
                          <span>82%</span>
                        </div>
                        <div className="mt-2 h-2 rounded-full bg-white/[0.08]">
                          <div className="h-2 w-[82%] rounded-full bg-[linear-gradient(90deg,_#818cf8,_#38bdf8)]" />
                        </div>
                      </div>
                      <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-4 text-sm text-slate-300">
                        Rendering locally with GPU acceleration
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
