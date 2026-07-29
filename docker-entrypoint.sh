#!/bin/sh
set -eu

: "${OCR_UPSTREAM:=ocr:8000}"
: "${LABEL_UPSTREAM:=label-api:8001}"
: "${LLM_UPSTREAM:=host.docker.internal:11434}"

resolve_docker_host() {
  host="$1"
  port="$2"
  if [ "$host" != "host.docker.internal" ]; then
    echo "${host}:${port}"
    return
  fi

  host_ip=""
  if command -v getent >/dev/null 2>&1; then
    host_ip=$(getent ahostsv4 host.docker.internal 2>/dev/null | awk '{print $1; exit}')
  fi
  if [ -z "$host_ip" ] && [ -r /etc/hosts ]; then
    host_ip=$(awk '$2=="host.docker.internal"{print $1; exit}' /etc/hosts)
  fi
  if [ -n "$host_ip" ]; then
    echo "${host_ip}:${port}"
    return
  fi

  echo "ERROR: cannot resolve host.docker.internal (check extra_hosts: host-gateway in compose)" >&2
  echo "${host}:${port}"
}

LLM_UPSTREAM_RAW="${LLM_UPSTREAM}"
LLM_HOST="${LLM_UPSTREAM_RAW%%:*}"
LLM_PORT="${LLM_UPSTREAM_RAW#*:}"
case "${LLM_UPSTREAM_RAW}" in
  *:*) ;;
  *) LLM_PORT="11434" ;;
esac

# Ollama 会校验 Host；经 Docker 转发到宿主机时使用 127.0.0.1
case "${LLM_UPSTREAM_RAW}" in
  host.docker.internal:*)
    LLM_PROXY_HOST="127.0.0.1:${LLM_PORT}"
    ;;
  *)
    LLM_PROXY_HOST="${LLM_UPSTREAM_RAW}"
    ;;
esac

# nginx 对变量 upstream 会走 127.0.0.11 DNS，无法解析 extra_hosts 里的 host.docker.internal
LLM_UPSTREAM=$(resolve_docker_host "${LLM_HOST}" "${LLM_PORT}")
export LLM_UPSTREAM LLM_PROXY_HOST

echo "OCR upstream: ${OCR_UPSTREAM}"
echo "Label API upstream: ${LABEL_UPSTREAM}"
echo "LLM (Ollama) upstream (raw): ${LLM_UPSTREAM_RAW}"
echo "LLM (Ollama) upstream (nginx): ${LLM_UPSTREAM}"
echo "LLM proxy Host header: ${LLM_PROXY_HOST}"

envsubst '${OCR_UPSTREAM} ${LABEL_UPSTREAM} ${LLM_UPSTREAM} ${LLM_PROXY_HOST}' \
  < /etc/nginx/templates/default.conf.template \
  > /etc/nginx/conf.d/default.conf

if ! nginx -t 2>/tmp/nginx-test.log; then
  echo "ERROR: nginx config invalid:"
  cat /tmp/nginx-test.log
  exit 1
fi

if wget -qO- --timeout=5 "http://${LLM_UPSTREAM}/api/tags" >/dev/null 2>&1; then
  echo "✓ Ollama reachable at http://${LLM_UPSTREAM}"
else
  echo "⚠ WARNING: Cannot reach Ollama at http://${LLM_UPSTREAM}/api/tags"
  echo "  常见原因与处理："
  echo "  1. Ollama 未启动 → 宿主机执行: ollama serve"
  echo "  2. 仅监听 127.0.0.1 → 改为: OLLAMA_HOST=0.0.0.0:11434 ollama serve"
  echo "     或 systemd: Environment=OLLAMA_HOST=0.0.0.0:11434"
  echo "  3. Ollama 在其它容器 → .env 设置 LLM_UPSTREAM=<容器名>:11434"
  echo "     并执行: docker network connect <网络名> <ollama容器名>"
  echo "  4. 容器内自测: docker exec ppocr-web wget -qO- http://${LLM_UPSTREAM}/api/tags"
fi

exec nginx -g 'daemon off;'
