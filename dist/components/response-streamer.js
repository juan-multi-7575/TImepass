export class ResponseStreamerHandler {
    name = 'responseStreamer';
    selectors = [
        'message-content',
        'model-response',
        '.model-response'
    ];
    queryDOM(root = document) {
        const elements = root.querySelectorAll(this.selectors.join(', '));
        if (elements.length > 0) {
            return elements[elements.length - 1]; // Return latest turn
        }
        return null;
    }
    async execute() {
        return true;
    }
}
//# sourceMappingURL=response-streamer.js.map