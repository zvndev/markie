//! Resolve remote images and document pointers without rewriting user files.
use super::Workspace;
use super::cloud::{landing_base, network};
use gpui_kit::*;
use markie_cloud::docs::DocsClient;
use markie_cloud::sync::SyncEngine;
use markie_cloud::{DEFAULT_SERVER, assets, links};
use markie_core::paths;
use std::collections::{HashMap, HashSet};

impl Workspace {
    pub(super) fn refresh_cloud_resources(&mut self, cx: &mut Context<Self>) {
        self.cloud.resource_epoch = self.cloud.resource_epoch.wrapping_add(1);
        let epoch = self.cloud.resource_epoch;
        let Some(path) = self.doc.as_ref().map(|d| d.path.clone()) else {
            return;
        };
        let root = landing_base().join("Markie RS").join("Cloud");
        let restricted =
            path.starts_with(&root) || root.canonicalize().is_ok_and(|real| path.starts_with(real));
        self.rich.update(cx, |view, cx| {
            view.set_cloud_resources(HashMap::new(), HashSet::new(), restricted, cx)
        });
        let Some((scope, id)) = self.cloud.bound_scope(&path) else {
            return;
        };
        let Some(super::OpenDoc {
            kind: super::DocKind::Text { saved, .. },
            ..
        }) = &self.doc
        else {
            return;
        };
        let references = assets::references(saved);
        let request = scope.clone();
        let cache = paths::data_dir().join("cloud-media");
        cx.spawn(async move |weak, cx| {
            let response = network(async move {
                let docs = DocsClient::new(&request.client);
                let links = links::fetch(&docs, &id)
                    .await
                    .unwrap_or_default()
                    .into_iter()
                    .map(|p| p.reference)
                    .collect();
                let mut media = HashMap::new();
                for reference in references
                    .into_iter()
                    .filter(|r| assets::mime(r).is_some_and(|mime| mime.starts_with("image/")))
                    .take(64)
                {
                    if let Ok(path) = assets::revalidate(
                        &docs,
                        &cache,
                        &request.user,
                        request.origin(),
                        &id,
                        &reference,
                    )
                    .await
                    {
                        media.insert(reference, path);
                    }
                }
                (media, links)
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
                if let Ok((media, links)) = response {
                    this.rich.update(cx, |view, cx| {
                        view.set_cloud_resources(media, links, restricted, cx)
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
                    .ok_or("The linked cloud document is not available to this account.")?;
                let engine = SyncEngine::new(&request.client, request.origin() == DEFAULT_SERVER);
                engine.pull(&target.target, &target.reference).await
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
                        this.land_cloud_doc(&scope, doc, record)
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
