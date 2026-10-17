#!/usr/bin/env bash
set -euo pipefail

namespace="grocery-offers"

npm ci
npm run build
kubectl create namespace "$namespace" --dry-run=client -o yaml | kubectl apply --server-side --force-conflicts -f -

for bundle in api matcher notifier store-analysis; do
  kubectl -n "$namespace" create configmap "spesavicina-${bundle}-bundle" \
    --from-file="${bundle}.mjs=dist/${bundle}.mjs" --dry-run=client -o yaml | kubectl apply --server-side --force-conflicts -f -
done
kubectl -n "$namespace" create configmap spesavicina-ingestor-bundle \
  --from-file=ingestor.mjs.gz=dist/ingestor.mjs.gz --dry-run=client -o yaml | kubectl apply --server-side --force-conflicts -f -
kubectl -n "$namespace" create configmap spesavicina-ocr-bundle \
  --from-file=ocr.mjs.gz=dist/ocr.mjs.gz --dry-run=client -o yaml | kubectl apply --server-side --force-conflicts -f -
kubectl -n "$namespace" create configmap spesavicina-public \
  --from-file=dist/public --dry-run=client -o yaml | kubectl apply --server-side --force-conflicts -f -

kubectl apply -f k8s/spesavicina.yaml
kubectl -n "$namespace" delete deployment/amazon-ingestor service/amazon-ingestor cronjob/amazon-ingestion --ignore-not-found

for deployment in spesavicina matching-worker notification-worker store-analysis-worker ocr-worker carrefour-ingestor esselunga-ingestor ekom-ingestor coop-ingestor lidl-ingestor ins-ingestor conad-ingestor md-ingestor pam-ingestor borello-ingestor crai-ingestor mercato-ingestor; do
  kubectl -n "$namespace" rollout status "deployment/${deployment}" --timeout=5m
done
