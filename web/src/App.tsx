import { Button } from "./components/Button";
import { FeatureCard } from "./components/FeatureCard";
import { Footer } from "./components/Footer";
import { Hero } from "./components/Hero";
import { Navbar } from "./components/Navbar";
import { Reveal } from "./components/Reveal";
import { StepItem } from "./components/StepItem";
import {
  DownloadIcon,
  ExportIcon,
  FaceIcon,
  GpuIcon,
  PlateIcon,
  PrivacyIcon,
  UploadIcon,
  WorkflowIcon,
} from "./components/icons";

const features = [
  {
    icon: <FaceIcon className="h-6 w-6" />,
    title: "Selective Blur",
    description:
      "Choose which faces stay sharp and which should be blurred before export.",
  },
  {
    icon: <GpuIcon className="h-6 w-6" />,
    title: "Fast GPU Processing",
    description:
      "Run high-speed local rendering optimized for desktop GPUs and longer edits.",
  },
  {
    icon: <PrivacyIcon className="h-6 w-6" />,
    title: "Privacy First",
    description:
      "Every frame is processed on your device, so sensitive footage never leaves your machine.",
  },
  {
    icon: <WorkflowIcon className="h-6 w-6" />,
    title: "Simple Workflow",
    description:
      "Import footage, review detections, export a polished file without extra manual masking.",
  },
];

const steps = [
  {
    title: "Upload Video",
    description: "Drop in MP4, MOV, or short-form clips from your desktop workflow.",
    icon: <UploadIcon className="h-5 w-5" />,
  },
  {
    title: "AI Detects Faces",
    description:
      "BluritOut scans faces and number plates frame by frame with local detection.",
    icon: <FaceIcon className="h-5 w-5" />,
  },
  {
    title: "Apply Blur",
    description:
      "Keep the people you want visible, blur the rest, and fine-tune before render.",
    icon: <PlateIcon className="h-5 w-5" />,
  },
  {
    title: "Export Video",
    description: "Render a share-ready file fast with your edits locked in.",
    icon: <ExportIcon className="h-5 w-5" />,
  },
];

function App() {
  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(99,102,241,0.16),_transparent_32%),radial-gradient(circle_at_80%_20%,_rgba(56,189,248,0.12),_transparent_20%),linear-gradient(180deg,_#0b0b0f_0%,_#0f1118_100%)] text-white">
      <Navbar />
      <main>
        <Hero />

        <section
          id="features"
          className="mx-auto max-w-7xl px-6 py-20 sm:px-8 lg:px-12 lg:py-28"
        >
          <Reveal className="mx-auto max-w-2xl text-center">
            <span className="inline-flex rounded-full border border-white/10 bg-white/5 px-4 py-1 text-sm font-medium text-slate-200">
              Built for privacy-first creators
            </span>
            <h2 className="mt-6 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              Automatic redaction without the editing overhead
            </h2>
            <p className="mt-4 text-base leading-7 text-slate-300 sm:text-lg">
              BluritOut keeps your workflow fast and your footage private with a
              focused desktop experience designed for real publishing deadlines.
            </p>
          </Reveal>

          <div className="mt-14 grid gap-6 md:grid-cols-2 xl:grid-cols-4">
            {features.map((feature, index) => (
              <Reveal key={feature.title} delay={index * 90}>
                <FeatureCard {...feature} />
              </Reveal>
            ))}
          </div>
        </section>

        <section className="border-y border-white/[0.08] bg-white/[0.02]">
          <div className="mx-auto max-w-7xl px-6 py-20 sm:px-8 lg:px-12 lg:py-24">
            <div className="grid gap-14 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
              <Reveal>
                <span className="inline-flex rounded-full border border-indigo-400/20 bg-indigo-500/10 px-4 py-1 text-sm font-medium text-indigo-200">
                  Workflow
                </span>
                <h2 className="mt-6 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                  From raw footage to export in four clear steps
                </h2>
                <p className="mt-4 max-w-xl text-base leading-7 text-slate-300 sm:text-lg">
                  The product is opinionated on purpose. Import, review
                  detections, apply blur, and export without bouncing between
                  plugins or online tools.
                </p>
              </Reveal>

              <div className="grid gap-4">
                {steps.map((step, index) => (
                  <Reveal key={step.title} delay={index * 90}>
                    <StepItem
                      index={index + 1}
                      isLast={index === steps.length - 1}
                      {...step}
                    />
                  </Reveal>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section
          id="demo"
          className="mx-auto max-w-7xl px-6 py-20 sm:px-8 lg:px-12 lg:py-28"
        >
          <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
            <Reveal>
              <span className="inline-flex rounded-full border border-white/10 bg-white/5 px-4 py-1 text-sm font-medium text-slate-200">
                Demo
              </span>
              <h2 className="mt-6 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                See BluritOut in action
              </h2>
              <p className="mt-4 max-w-xl text-base leading-7 text-slate-300 sm:text-lg">
                A focused desktop workflow for creators handling interviews,
                street footage, customer recordings, and any video where privacy
                needs to be preserved before publishing.
              </p>
              <div className="mt-8 flex flex-wrap gap-3 text-sm text-slate-300">
                <div className="rounded-full border border-white/10 bg-white/5 px-4 py-2">
                  Local face detection
                </div>
                <div className="rounded-full border border-white/10 bg-white/5 px-4 py-2">
                  Number plate redaction
                </div>
                <div className="rounded-full border border-white/10 bg-white/5 px-4 py-2">
                  Windows desktop app
                </div>
              </div>
            </Reveal>

            <Reveal delay={120}>
              <div className="overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950/70 shadow-[0_30px_80px_rgba(0,0,0,0.45)]">
                <div className="flex items-center justify-between border-b border-white/[0.08] px-5 py-4">
                  <div>
                    <p className="text-sm font-medium text-white">
                      Demo Preview
                    </p>
                    <p className="text-sm text-slate-400">
                      See detected faces and blurred output side by side
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full bg-rose-400/80" />
                    <span className="h-2.5 w-2.5 rounded-full bg-amber-300/80" />
                    <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/80" />
                  </div>
                </div>

                <div className="relative aspect-video bg-[linear-gradient(135deg,_rgba(30,41,59,0.75),_rgba(15,23,42,0.95))] p-4 sm:p-6">
                  <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,_rgba(99,102,241,0.2),_transparent_30%),linear-gradient(180deg,_transparent,_rgba(15,23,42,0.65))]" />
                  <div className="absolute left-4 top-4 rounded-full border border-white/10 bg-slate-900/80 px-3 py-1 text-xs uppercase tracking-[0.2em] text-slate-300 sm:left-6 sm:top-6">
                    Video player placeholder
                  </div>
                  <div className="relative grid h-full gap-4 sm:grid-cols-2">
                    <div className="rounded-[1.4rem] border border-white/10 bg-slate-900/80 p-4">
                      <p className="text-xs font-medium uppercase tracking-[0.24em] text-slate-400">
                        Source
                      </p>
                      <div className="relative mt-4 h-[calc(100%-2rem)] rounded-[1.1rem] bg-[linear-gradient(180deg,_rgba(71,85,105,0.5),_rgba(15,23,42,0.9))]">
                        <div className="absolute left-[16%] top-[22%] h-16 w-16 rounded-full border border-cyan-300/60 bg-cyan-300/10 sm:h-20 sm:w-20" />
                        <div className="absolute left-[56%] top-[28%] h-14 w-14 rounded-full border border-cyan-300/60 bg-cyan-300/10 sm:h-[4.5rem] sm:w-[4.5rem]" />
                        <div className="absolute bottom-[16%] left-[22%] h-7 w-20 rounded-lg border border-cyan-300/60 bg-cyan-300/10" />
                      </div>
                    </div>

                    <div className="rounded-[1.4rem] border border-indigo-400/20 bg-slate-950/75 p-4">
                      <p className="text-xs font-medium uppercase tracking-[0.24em] text-indigo-200">
                        Output
                      </p>
                      <div className="relative mt-4 h-[calc(100%-2rem)] overflow-hidden rounded-[1.1rem] bg-[linear-gradient(180deg,_rgba(51,65,85,0.5),_rgba(2,6,23,0.95))]">
                        <div className="absolute inset-0 bg-[linear-gradient(180deg,_transparent,_rgba(99,102,241,0.15))]" />
                        <div className="absolute left-[14%] top-[20%] h-20 w-20 rounded-full bg-slate-300/20 blur-[6px]" />
                        <div className="absolute left-[56%] top-[28%] h-[4.5rem] w-[4.5rem] rounded-full bg-slate-300/20 blur-[6px]" />
                        <div className="absolute bottom-[16%] left-[21%] h-8 w-24 rounded-lg bg-slate-300/20 blur-[4px]" />
                        <div className="absolute inset-x-0 top-0 h-1/3 animate-[scan_5s_ease-in-out_infinite] bg-[linear-gradient(180deg,_rgba(99,102,241,0.18),_transparent)]" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </Reveal>
          </div>
        </section>

        <section
          id="download"
          className="mx-auto max-w-7xl px-6 pb-24 sm:px-8 lg:px-12 lg:pb-28"
        >
          <Reveal>
            <div className="overflow-hidden rounded-[2rem] border border-white/10 bg-[linear-gradient(135deg,_rgba(79,70,229,0.18),_rgba(15,23,42,0.92)_40%,_rgba(8,47,73,0.65))] px-6 py-10 shadow-[0_28px_80px_rgba(0,0,0,0.35)] sm:px-10 sm:py-12 lg:px-14">
              <div className="grid gap-8 lg:grid-cols-[1.2fr_auto] lg:items-center">
                <div>
                  <span className="inline-flex rounded-full border border-white/[0.15] bg-white/[0.08] px-4 py-1 text-sm font-medium text-white">
                    Download
                  </span>
                  <h2 className="mt-6 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                    Download BluritOut
                  </h2>
                  <p className="mt-4 max-w-2xl text-base leading-7 text-slate-200 sm:text-lg">
                    Windows version available now. Install locally, process
                    privately, and publish without exposing faces or number
                    plates you should not show.
                  </p>
                  <div className="mt-6 flex flex-wrap items-center gap-3 text-sm text-slate-200">
                    <span className="rounded-full border border-white/[0.12] bg-black/[0.15] px-4 py-2">
                      Version v1.0.0
                    </span>
                    <span className="rounded-full border border-white/[0.12] bg-black/[0.15] px-4 py-2">
                      Windows 10+
                    </span>
                    <span className="rounded-full border border-white/[0.12] bg-black/[0.15] px-4 py-2">
                      Local processing
                    </span>
                  </div>
                </div>

                <div className="flex flex-col items-start gap-4 lg:items-end">
                  <Button
                    href="/downloads/BluritOut-Setup-v1.0.0.exe"
                    variant="primary"
                    size="lg"
                    download
                  >
                    <DownloadIcon className="h-5 w-5" />
                    Download .exe
                  </Button>
                  <p className="max-w-xs text-sm leading-6 text-slate-300 lg:text-right">
                    Installer target:
                    <span className="font-medium text-white">
                      {" "}
                      /public/downloads/BluritOut-Setup-v1.0.0.exe
                    </span>
                  </p>
                </div>
              </div>
            </div>
          </Reveal>
        </section>
      </main>
      <Footer />
    </div>
  );
}

export default App;
