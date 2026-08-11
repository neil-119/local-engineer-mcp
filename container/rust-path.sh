# Codex executes commands with `bash -lc`; Debian's login profile reconstructs
# PATH, so preserve the Rust toolchain for every worker command.
export RUSTUP_HOME=/usr/local/rustup
export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"

case ":$PATH:" in
  *:/usr/local/cargo/bin:*) ;;
  *) export PATH="/usr/local/cargo/bin:$PATH" ;;
esac
