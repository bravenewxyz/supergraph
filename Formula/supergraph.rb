class Supergraph < Formula
  desc "Unified code analysis toolkit — semantic graphs, complexity, dead exports, contracts, and more"
  homepage "https://github.com/bravenewxyz/supergraph"
  version "1.0.3"

  on_macos do
    on_arm do
      url "https://github.com/bravenewxyz/supergraph/releases/download/v1.0.3/supergraph-darwin-arm64.tar.gz"
      sha256 "a03e881197f2c0daf7926e8e8677e5afc39aa5129c723fc1d7e312e9b4396d96"
    end

    on_intel do
      url "https://github.com/bravenewxyz/supergraph/releases/download/v1.0.3/supergraph-darwin-x64.tar.gz"
      sha256 "45fd81b2eddf1d4415db12796052f80b037b6e9afa825a296f61eeac545027d4"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/bravenewxyz/supergraph/releases/download/v1.0.3/supergraph-linux-x64.tar.gz"
      sha256 "92b7b709a7699aff706e0c14cf70ca56c75657e802aa0748b22e225522889dba"
    end
  end

  def install
    bin.install "supergraph"
  end

  test do
    assert_match "supergraph", shell_output("#{bin}/supergraph --help")
  end
end
