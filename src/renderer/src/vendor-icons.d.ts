// @hugeicons/core-free-icons ships icon data as deep ESM paths with no bundled
// type declarations, so each `import X from "@hugeicons/core-free-icons/XIcon"`
// trips TS7016 under noImplicitAny. The runtime value is icon data passed to
// the Hugeicons renderer; `any` is the honest type here.
declare module '@hugeicons/core-free-icons/*'
