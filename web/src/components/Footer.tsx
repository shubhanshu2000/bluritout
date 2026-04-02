export function Footer() {
  return (
    <footer className="border-t border-white/[0.08] bg-black/20">
      <div className="mx-auto flex max-w-7xl flex-col gap-8 px-6 py-10 text-sm text-slate-400 sm:px-8 lg:flex-row lg:items-center lg:justify-between lg:px-12">
        <div>
          <p className="text-lg font-semibold tracking-tight text-white">
            BluritOut
          </p>
          <p className="mt-2 max-w-md leading-6">
            Desktop face and number plate blurring built for creators who need
            privacy without adding friction to the edit.
          </p>
        </div>

        <div className="flex flex-wrap gap-6">
          <a
            href="#"
            className="transition hover:text-white"
            aria-label="Privacy policy"
          >
            Privacy
          </a>
          <a
            href="mailto:contact@bluritout.app"
            className="transition hover:text-white"
          >
            Contact
          </a>
        </div>
      </div>
    </footer>
  );
}
