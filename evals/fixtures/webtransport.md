# English

# WebTransport: Reliable and Unreliable Streams over HTTP/3

WebTransport is a web API and protocol framework for bidirectional communication between a client and an HTTP/3 server. This fixture demonstrates the bilingual article shape used by the publishing skill.

## How it works

An application creates a session and then chooses reliable streams or unreliable datagrams according to its delivery requirements.

## Example

```javascript
const transport = new WebTransport('https://example.com/session')
await transport.ready
```

## Security considerations

Deployments must use secure transport, validate application messages, and apply resource limits.

## Sources

- [W3C WebTransport](https://www.w3.org/TR/webtransport/)
- [IETF WebTransport over HTTP/3](https://datatracker.ietf.org/doc/rfc9297/)
- [MDN WebTransport](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport)

---

# 中文

# WebTransport：基于 HTTP/3 的可靠流与不可靠数据报

WebTransport 是面向客户端与 HTTP/3 服务器双向通信的 Web API 和协议框架。本夹具用于展示发布 Skill 采用的双语文章结构。

## 工作原理

应用建立会话后，可以根据交付需求选择可靠流或不可靠数据报。

## 示例

```javascript
const transport = new WebTransport('https://example.com/session')
await transport.ready
```

## 安全注意事项

部署时必须使用安全传输、校验应用消息并设置资源限制。

## 来源

- [W3C WebTransport](https://www.w3.org/TR/webtransport/)
- [IETF WebTransport over HTTP/3](https://datatracker.ietf.org/doc/rfc9297/)
- [MDN WebTransport](https://developer.mozilla.org/zh-CN/docs/Web/API/WebTransport)
