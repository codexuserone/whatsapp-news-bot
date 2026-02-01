#!/bin/sh
set -eu

exec env -u http-proxy -u https-proxy -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u npm_config_http_proxy -u npm_config_https_proxy npm "$@"
