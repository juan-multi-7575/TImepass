export class ImageUploaderHandler {
    name = 'imageUploader';
    selectors = [
        'input[type="file"]',
        'button[aria-label*="Upload"]',
        'button[aria-label*="Attach"]'
    ];
    queryDOM(root = document) {
        for (const selector of this.selectors) {
            const el = root.querySelector(selector);
            if (el)
                return el;
        }
        return null;
    }
    async execute(args) {
        const filePaths = args?.filePaths;
        if (!filePaths || filePaths.length === 0)
            return false;
        const uploader = this.queryDOM();
        if (!uploader)
            return false;
        // Handle file input upload
        return true;
    }
}
//# sourceMappingURL=image-uploader.js.map