require "language/node"

# Homebrew formula for @sfdt/cli.
#
# Distribution model: this installs the published npm package into the formula's
# libexec and symlinks the `sfdt` bin onto PATH. The url + sha256 below MUST be
# bumped on every release (see the `release` skill checklist):
#
#   VERSION=x.y.z
#   url    -> https://registry.npmjs.org/@sfdt/cli/-/cli-${VERSION}.tgz
#   sha256 -> shasum -a 256 of that tarball
#
# Install (from the tap):
#   brew install scoobydrew83/sfdt/sfdt
class Sfdt < Formula
  desc "Salesforce DX deployment, testing, quality analysis, and release CLI"
  homepage "https://github.com/scoobydrew83/sfdt"
  url "https://registry.npmjs.org/@sfdt/cli/-/cli-0.13.1.tgz"
  sha256 "643d09a3124f9c8cc2c162ba5567216f596a69abfa76d914a2e1660fd3374ebd"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *Language::Node.std_npm_install_args(libexec)
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  def caveats
    <<~EOS
      sfdt needs these at runtime (not installed by this formula):
        - Salesforce CLI:  npm install -g @salesforce/cli
        - jq:              brew install jq

      Optional, for AI features and PR creation:
        - Claude Code / Gemini / Codex CLI  (or configure an HTTP provider)
        - GitHub CLI:  brew install gh

      Get started:
        cd your-sf-project && sfdt init
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/sfdt --version")
  end
end
