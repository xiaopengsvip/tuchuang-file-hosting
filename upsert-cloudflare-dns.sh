#!/usr/bin/env bash
set -euo pipefail
: "${CLOUDFLARE_API_TOKEN:?export CLOUDFLARE_API_TOKEN first}"
ZONE=allapple.top
ORIGIN_IP=${ORIGIN_IP:-43.167.213.143}
PROXIED=${PROXIED:-true}
API=https://api.cloudflare.com/client/v4
AUTH=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json")

zone_json=$(curl -fsS "${AUTH[@]}" "$API/zones?name=$ZONE")
zone_id=$(jq -r '.result[0].id // empty' <<<"$zone_json")
if [[ -z "$zone_id" ]]; then
  echo "Zone not found or token lacks Zone:Read: $ZONE" >&2
  exit 1
fi

upsert_a() {
  local name=$1
  local list rec_id payload method url
  list=$(curl -fsS "${AUTH[@]}" "$API/zones/$zone_id/dns_records?type=A&name=$name")
  rec_id=$(jq -r '.result[0].id // empty' <<<"$list")
  payload=$(jq -n --arg type A --arg name "$name" --arg content "$ORIGIN_IP" --argjson proxied "$PROXIED" '{type:$type,name:$name,content:$content,ttl:1,proxied:$proxied}')
  if [[ -n "$rec_id" ]]; then
    echo "Updating $name -> $ORIGIN_IP proxied=$PROXIED"
    curl -fsS -X PUT "${AUTH[@]}" --data "$payload" "$API/zones/$zone_id/dns_records/$rec_id" | jq '{success,errors,result:{id:.result.id,name:.result.name,type:.result.type,content:.result.content,proxied:.result.proxied}}'
  else
    echo "Creating $name -> $ORIGIN_IP proxied=$PROXIED"
    curl -fsS -X POST "${AUTH[@]}" --data "$payload" "$API/zones/$zone_id/dns_records" | jq '{success,errors,result:{id:.result.id,name:.result.name,type:.result.type,content:.result.content,proxied:.result.proxied}}'
  fi
}

upsert_a tuchuang.allapple.top
upsert_a tc.allapple.top

dig +short @1.1.1.1 tuchuang.allapple.top A || true
dig +short @1.1.1.1 tc.allapple.top A || true
