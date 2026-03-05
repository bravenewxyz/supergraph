class Supergraph < Formula
  desc "Unified code analysis toolkit — semantic graphs, complexity, dead exports, contracts, and more"
  homepage "https://github.com/bravenewxyz/supergraph"
  version "0.1.0"

  on_macos do
    on_arm do
      url "https://github.com/bravenewxyz/supergraph/releases/download/v#{version}/supergraph-darwin-arm64.tar.gz"
      sha256 "PLACEHOLDER"
    end

    on_intel do
      url "https://github.com/bravenewxyz/supergraph/releases/download/v#{version}/supergraph-darwin-x64.tar.gz"
      sha256 "PLACEHOLDER"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bravenewxyz/supergraph/releases/download/v#{version}/supergraph-linux-x64.tar.gz"
      sha256 "PLACEHOLDER"
    end
  end

  def install
    bin.install "supergraph"
  end

  test do
    assert_match "supergraph", shell_output("#{bin}/supergraph --help")
  end
end
