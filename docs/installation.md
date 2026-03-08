# Installation

## Prerequisites

- **Node.js 20.19.0 or higher** — Check your version: `node --version`

## Package Managers

### npm

```bash
npm install -g @bym-ai/infraspec@latest
```

### pnpm

```bash
pnpm add -g @bym-ai/infraspec@latest
```

### yarn

```bash
yarn global add @bym-ai/infraspec@latest
```

### bun

```bash
bun add -g @bym-ai/infraspec@latest
```

## Nix

Run InfraSpec directly without installation:

```bash
nix run github:Bym-AI/InfraSpec -- init
```

Or install to your profile:

```bash
nix profile install github:Bym-AI/InfraSpec
```

Or add to your development environment in `flake.nix`:

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    infraspec.url = "github:Bym-AI/InfraSpec";
  };

  outputs = { nixpkgs, infraspec, ... }: {
    devShells.x86_64-linux.default = nixpkgs.legacyPackages.x86_64-linux.mkShell {
      buildInputs = [ infraspec.packages.x86_64-linux.default ];
    };
  };
}
```

## Verify Installation

```bash
infraspec --version
```

## Next Steps

After installing, initialize InfraSpec in your project:

```bash
cd your-project
infraspec init
```

See [Getting Started](getting-started.md) for a full walkthrough.
