/**
 * Provenance of every font file in this directory (UI-1, brand fonts). Each entry names the official distribution
 * it was taken from, the release or commit, the byte size and the SHA-256 of the file as tracked here, and the
 * license text kept beside it. tests/unit/ui/fonts.test.ts recomputes the hashes and refuses any other font binary
 * in the repository. All three families are licensed under the SIL Open Font License 1.1.
 *
 * Pure data; imported by tests and by nothing at runtime (next/font/local reads the files directly).
 */

export interface FontFileRecord {
  /** Repository path. */
  readonly path: string;
  readonly family: "Outfit" | "Inter" | "JetBrains Mono";
  /** Weights this file provides: a static weight, or the variable axis range. */
  readonly weights: string;
  readonly format: "woff2" | "ttf";
  readonly bytes: number;
  readonly sha256: string;
  /** Official distribution the file was copied from, byte for byte. */
  readonly source: string;
  readonly version: string;
  /** The license text kept next to the file, copied from the same distribution. */
  readonly license: string;
}

export const FONT_FILES: readonly FontFileRecord[] = [
  {
    path: "ui/foundations/fonts/outfit/Outfit[wght].ttf",
    family: "Outfit",
    weights: "100 900 (variable; the manual uses 400 and 600)",
    format: "ttf",
    bytes: 110884,
    sha256: "fc7287273e66929776e2ba54f144fe699080bec29f61bf649d70d871468aeade",
    source: "github.com/google/fonts — ofl/outfit/Outfit[wght].ttf at commit 8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5 (git blob 466d6245f9582df39bf73da91a8b3c938fd061cd)",
    version: "Version 1.100;gftools[0.9.27]",
    license: "ui/foundations/fonts/outfit/OFL.txt",
  },
  {
    path: "ui/foundations/fonts/inter/Inter-Regular.woff2",
    family: "Inter",
    weights: "400",
    format: "woff2",
    bytes: 111268,
    sha256: "e06f6b1bc553aaea4e4668023ed0ab0a147129c3107f511bc7d03d361b0ae085",
    source: "github.com/rsms/inter — GitHub release v4.1 (2024-11-16), asset Inter-4.1.zip, entry web/Inter-Regular.woff2",
    version: "Inter 4.1 (release v4.1, 2024-11-16; font Version 4.001)",
    license: "ui/foundations/fonts/inter/LICENSE.txt",
  },
  {
    path: "ui/foundations/fonts/inter/Inter-Medium.woff2",
    family: "Inter",
    weights: "500",
    format: "woff2",
    bytes: 114348,
    sha256: "0ff3e94614e1493eb556314fd247ae6c4a85a7783b4cc86be539940cf83f2a48",
    source: "github.com/rsms/inter — GitHub release v4.1 (2024-11-16), asset Inter-4.1.zip, entry web/Inter-Medium.woff2",
    version: "Inter 4.1 (release v4.1, 2024-11-16; font Version 4.001)",
    license: "ui/foundations/fonts/inter/LICENSE.txt",
  },
  {
    path: "ui/foundations/fonts/jetbrains-mono/JetBrainsMono-Regular.woff2",
    family: "JetBrains Mono",
    weights: "400",
    format: "woff2",
    bytes: 92164,
    sha256: "a9cb1cd82332b23a47e3a1239d25d13c86d16c4220695e34b243effa999f45f2",
    source: "github.com/JetBrains/JetBrainsMono — GitHub release v2.304 (2023-01-14), asset JetBrainsMono-2.304.zip, entry fonts/webfonts/JetBrainsMono-Regular.woff2",
    version: "JetBrains Mono 2.304 (release v2.304, 2023-01-14)",
    license: "ui/foundations/fonts/jetbrains-mono/OFL.txt",
  },
  {
    path: "ui/foundations/fonts/jetbrains-mono/JetBrainsMono-Medium.woff2",
    family: "JetBrains Mono",
    weights: "500",
    format: "woff2",
    bytes: 93824,
    sha256: "086c48dfbea9ddaff1320f7e09399b8e2924e88ce67453721255db3bdbb5a353",
    source: "github.com/JetBrains/JetBrainsMono — GitHub release v2.304 (2023-01-14), asset JetBrainsMono-2.304.zip, entry fonts/webfonts/JetBrainsMono-Medium.woff2",
    version: "JetBrains Mono 2.304 (release v2.304, 2023-01-14)",
    license: "ui/foundations/fonts/jetbrains-mono/OFL.txt",
  },
];

/** License and attribution texts kept beside the fonts, with their SHA-256 as copied from the distributions. */
export const FONT_LICENSE_FILES: readonly { readonly path: string; readonly sha256: string; readonly holder: string }[] = [
  { path: "ui/foundations/fonts/outfit/OFL.txt", sha256: "c676351bf8576b9aba743cd5eaa8c0e7ee0d51f805d720447b4df4ddb6a2e416", holder: "Copyright 2021 The Outfit Project Authors (https://github.com/Outfitio/Outfit-Fonts)" },
  { path: "ui/foundations/fonts/inter/LICENSE.txt", sha256: "262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a", holder: "Copyright (c) 2016 The Inter Project Authors (https://github.com/rsms/inter)" },
  { path: "ui/foundations/fonts/jetbrains-mono/OFL.txt", sha256: "30f0c136e3c88e422d0791acd97238870f9054a9729bc34cf2ff0d4ed8cac4ad", holder: "Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)" },
  { path: "ui/foundations/fonts/jetbrains-mono/AUTHORS.txt", sha256: "33f99c94ef0a0909d7584a5d4bde1fb9b1630daa620f5a788c28c43327e79412", holder: "JetBrains Mono authors list (shipped with the release)" },
];
