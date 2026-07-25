use anyhow::{Context, Result};
use codex_network_proxy::{
    ConfigReloader, ConfigReloaderFuture, ConfigState, NetworkProxy, NetworkProxyConfig,
    NetworkProxyConstraints, NetworkProxyState, build_config_state,
};
use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

struct StaticConfigReloader {
    state: ConfigState,
}

impl ConfigReloader for StaticConfigReloader {
    fn source_label(&self) -> String {
        "Local Engineer generated proxy config".to_string()
    }

    fn maybe_reload(&self) -> ConfigReloaderFuture<'_, Option<ConfigState>> {
        Box::pin(async { Ok(None) })
    }

    fn reload_now(&self) -> ConfigReloaderFuture<'_, ConfigState> {
        let state = self.state.clone();
        Box::pin(async move { Ok(state) })
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let codex_home = env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .context("CODEX_HOME is required")?;
    let config_path = codex_home.join("config.toml");
    let contents = fs::read_to_string(&config_path)
        .with_context(|| format!("failed to read {}", config_path.display()))?;
    let config: NetworkProxyConfig =
        toml::from_str(&contents).context("failed to parse network proxy config")?;
    let state = build_config_state(config, NetworkProxyConstraints::default())?;
    let reloader = Arc::new(StaticConfigReloader {
        state: state.clone(),
    });
    let state = Arc::new(NetworkProxyState::with_reloader(state, reloader));
    let proxy = NetworkProxy::builder()
        .state(state)
        .managed_by_codex(false)
        .build()
        .await?;
    proxy.run().await?.wait().await
}
