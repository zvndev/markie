//! Resolve remote images and document pointers without rewriting user files.
use super::Workspace;
use super::account::AccountStore;
use super::cloud::{landing_base, network};
use gpui_kit::*;
use markie_cloud::asset_cache::{AssetCache, CACHE_DIRECTORY};
use markie_cloud::docs::DocsClient;
use markie_cloud::sync::SyncEngine;
use markie_cloud::{DEFAULT_SERVER, assets, links};
use markie_core::paths;
use std::collections::{HashMap, HashSet};

/// doc-link-open.js: a linked document that could not be brought here.
const LANDING_FAILED: &str = "Couldn't open that document. Check your connection, or ask for it to be shared again.";

impl Workspace {
    pub(super) fn refresh_cloud_resources(&mut self, cx: &mut Context<Self>) {
        self.cloud.resource_epoch = self.cloud.resource_epoch.wrapping_add(1);
        let epoch = self.cloud.resource_epoch;
        let account = AccountStore::global(cx);
        let excluded = account.as_ref().and_then(|account| account.read(cx).cache_excluded_origin()).map(str::to_owned);
        let scopes = self.cache_scopes(cx);
        let cache = AssetCache::bind_sessions(&paths::data_dir().join(CACHE_DIRECTORY), scopes).ok().flatten();
        // The cloud thumbnails belong to the same accounts as the media.
        self.bind_cloud_previews(cx);
        let Some(path) = self.doc.as_ref().map(|d| d.path.clone()) else {
            return;
        };
        let root = landing_base().join(paths::APP_NAME).join("Cloud");
        let restricted =
            path.starts_with(&root) || root.canonicalize().is_ok_and(|real| path.starts_with(real));
        self.rich.update(cx, |view, cx| {
            view.set_cloud_resources(HashMap::new(), HashSet::new(), restricted, cx);
            view.set_unshared_links(HashSet::new(), cx);
        });
        let Some((scope, id)) = self.cloud.bound_scope(&path) else {
            return;
        };
        if Some(scope.origin()) == excluded.as_deref() || self.cloud.media_signing_out.contains(scope.origin()) {
            return;
        }
        let Some(super::OpenDoc {
            kind: super::DocKind::Text { saved, .. },
            ..
        }) = &self.doc
        else {
            return;
        };
        let references = assets::references(saved);
        let doc_dir = path.parent().map(std::path::Path::to_path_buf);
        let request = scope.clone();
        cx.spawn(async move |weak, cx| {
            let response = network(async move {
                let docs = DocsClient::new(&request.client);
                let (open, refused) = links::fetch_all(&docs, &id).await.unwrap_or_default();
                let links: HashSet<String> = open.into_iter().map(|p| p.reference).collect();
                // Disk wins over the cloud (doc-link-open.js): a target that
                // sits beside the document opens as a local file, unmuted.
                let refused: HashSet<String> = refused
                    .into_iter()
                    .filter(|r| doc_dir.as_ref().is_none_or(|d| !d.join(r).exists()))
                    .collect();
                let mut media = HashMap::new();
                if let Some(cache) = cache {
                    for reference in references.into_iter()
                        .filter(|r| assets::mime(r).is_some_and(|mime| ["image/", "video/", "audio/"].iter().any(|kind| mime.starts_with(kind))))
                        .take(64)
                    {
                        if let Ok(path) = assets::revalidate(&docs, &cache, &request.user, request.origin(), &id, &reference).await {
                            media.insert(reference, path);
                        }
                    }
                }
                (media, links, refused)
            })
            .await;
            let _ = weak.update(cx, |this, cx| {
                if this.cloud.resource_epoch != epoch
                    || !scope.active()
                    || this
                        .cloud
                        .scope(scope.origin())
                        .is_none_or(|fresh| fresh.user != scope.user)
                {
                    return;
                }
                if let Ok((media, links, refused)) = response {
                    this.rich.update(cx, |view, cx| {
                        view.set_cloud_resources(media, links, restricted, cx);
                        view.set_unshared_links(refused, cx);
                    });
                }
            });
        })
        .detach();
    }

    pub(super) fn follow_cloud_link(&mut self, reference: &str, cx: &mut Context<Self>) {
        let Some(path) = self.doc.as_ref().map(|d| d.path.clone()) else {
            return;
        };
        let Some((scope, source_id)) = self.cloud.bound_scope(&path) else {
            return;
        };
        let reference = reference.to_owned();
        let request = scope.clone();
        cx.spawn(async move |weak, cx| {
            let response = network(async move {
                let docs = DocsClient::new(&request.client);
                let answer = links::fetch(&docs, &source_id)
                    .await
                    .map_err(|e| e.to_string())?;
                let target = answer
                    .into_iter()
                    .find(|link| link.reference == reference)
                    .ok_or(markie_editor::NOT_SHARED)?;
                let engine = SyncEngine::new(&request.client, request.origin() == DEFAULT_SERVER);
                // doc-link-open.js LANDING_FAILED, whatever stopped the landing.
                engine.pull(&target.target, &target.reference).await.map_err(|_| LANDING_FAILED.to_string())
            })
            .await
            .and_then(|r| r);
            let _ = weak.update(cx, |this, cx| {
                if !scope.active()
                    || this.doc.as_ref().is_none_or(|d| d.path != path)
                    || this
                        .cloud
                        .scope(scope.origin())
                        .is_none_or(|fresh| fresh.user != scope.user)
                {
                    return;
                }
                let target = response.and_then(|(doc, record)| {
                    if let Some(id) = record.cloud_doc_id.as_deref()
                        && let Some(path) = this.cloud.find(&scope, id).filter(|p| p.is_file())
                    {
                        Ok(path)
                    } else {
                        this.land_cloud_doc(&scope, doc, record).map_err(|_| LANDING_FAILED.to_string())
                    }
                });
                match target {
                    Ok(path) => this.cloud.pending_link = Some(path),
                    Err(error) => this.cloud.notice = Some(error),
                }
                cx.notify();
            });
        })
        .detach();
    }
}
