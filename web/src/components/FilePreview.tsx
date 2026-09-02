// 文件预览：图片/PDF/Office(离线渲染)/文本/音视频
import { useEffect, useRef, useState } from 'react';
import { Modal, Spin, Result, Button, Typography, Space, Progress, message } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { renderAsync } from 'docx-preview';
import * as XLSX from 'xlsx';
import { filesApi } from '../api';
import type { FileItem } from '../api/types';
import { getPreviewKind, getExt } from '../utils/constants';
import { formatSize } from '../utils/format';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// 文本/表格预览拉取上限：超过则提示下载查看（避免大文件整体拉取卡死页面）
const PREVIEW_FETCH_LIMIT = 1024 * 1024;

interface Props {
  file: FileItem | null;
  onClose: () => void;
}

export default function FilePreview({ file, onClose }: Props) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [xlsData, setXlsData] = useState<unknown[][]>([]);
  const [pdfProgress, setPdfProgress] = useState(0);
  const [pdfTotal, setPdfTotal] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const pdfContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!file || file.type !== 'file') return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setText('');
    setXlsData([]);
    setUrl('');
    setPdfProgress(0);
    setPdfTotal(0);

    filesApi
      .preview(file.id)
      .then(async ({ url: u }) => {
        if (cancelled) return;
        setUrl(u);
        const kind = getPreviewKind(file.name);
        if (kind === 'text') {
          if ((file.size ?? 0) > PREVIEW_FETCH_LIMIT) {
            setError('文件较大（超过 1MB），在线预览仅支持小文件，请下载后查看');
            return;
          }
          const res = await fetch(u);
          setText(await res.text());
        } else if (kind === 'xls') {
          if ((file.size ?? 0) > PREVIEW_FETCH_LIMIT) {
            setError('文件较大（超过 1MB），在线预览仅支持小文件，请下载后查看');
            return;
          }
          const res = await fetch(u);
          const buf = await res.arrayBuffer();
          const wb = XLSX.read(buf, { type: 'array' });
          const ws = wb.Sheets[wb.SheetNames[0]];
          setXlsData(XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as unknown[][]);
        }
      })
      .catch((e) => setError((e as Error).message || '预览失败'))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  // PDF 渲染（带页数进度）
  useEffect(() => {
    if (!url || !file || getPreviewKind(file.name) !== 'pdf') return;
    let cancelled = false;
    (async () => {
      try {
        const pdf = await pdfjsLib.getDocument({ url }).promise;
        if (cancelled || !pdfContainerRef.current) return;
        const container = pdfContainerRef.current;
        container.innerHTML = '';
        const total = Math.min(pdf.numPages, 50);
        setPdfTotal(total);
        for (let pageNo = 1; pageNo <= total; pageNo++) {
          const page = await pdf.getPage(pageNo);
          const base = Math.min(container.clientWidth - 32, 900);
          const viewport = page.getViewport({ scale: base / page.getViewport({ scale: 1 }).width });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          container.appendChild(canvas);
          await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
          if (!cancelled) setPdfProgress(pageNo);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message || 'PDF 渲染失败');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url, file]);

  // Office 渲染（docx-preview 离线渲染 docx；xls 走 SheetJS）
  useEffect(() => {
    if (!url || !file) return;
    const kind = getPreviewKind(file.name);
    const ext = getExt(file.name);
    if (kind === 'doc' && ext === 'docx') {
      (async () => {
        try {
          const res = await fetch(url);
          const blob = await res.blob();
          if (containerRef.current) {
            containerRef.current.innerHTML = '';
            await renderAsync(blob, containerRef.current);
          }
        } catch (e) {
          setError((e as Error).message || '文档渲染失败');
        }
      })();
    }
  }, [url, file]);

  if (!file) return null;
  const kind = getPreviewKind(file.name);
  const ext = getExt(file.name);

  const renderBody = (): React.ReactNode => {
    if (loading) return <Spin size="large" style={{ margin: '120px auto', display: 'block' }} />;
    if (error) {
      return (
        <Result
          status="warning"
          title="无法预览"
          subTitle={error}
          extra={
            <Button type="primary" icon={<DownloadOutlined />} onClick={() => void handleDownload()}>
              下载查看
            </Button>
          }
        />
      );
    }
    switch (kind) {
      case 'image':
        return (
          <div className="preview-container">
            <img src={url} alt={file.name} />
          </div>
        );
      case 'pdf':
        return (
          <div>
            {pdfTotal > 0 && pdfProgress < pdfTotal && (
              <div style={{ padding: 8, borderBottom: '1px solid #f0f0f0' }}>
                <Progress percent={Math.round((pdfProgress / pdfTotal) * 100)} size="small" format={() => `渲染中 ${pdfProgress}/${pdfTotal} 页`} />
              </div>
            )}
            <div className="pdf-preview" ref={pdfContainerRef} />
          </div>
        );
      case 'doc':
        if (ext !== 'docx') {
          return (
            <Result
              status="info"
              title="旧版 .doc 文档暂不支持在线预览（离线环境限制）"
              subTitle="请下载后使用本地 Office 查看"
              extra={<Button type="primary" icon={<DownloadOutlined />} onClick={() => void handleDownload()}>下载</Button>}
            />
          );
        }
        return <div className="doc-preview" ref={containerRef} />;
      case 'xls':
        return (
          <div className="xls-preview">
            <table border={1} cellPadding={6} style={{ borderCollapse: 'collapse', width: '100%' }}>
              <tbody>
                {xlsData.slice(0, 200).map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j} style={{ border: '1px solid #e5e5e5', fontSize: 13 }}>
                        {String(cell ?? '')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {xlsData.length > 200 && <Typography.Text type="secondary">仅预览前 200 行，完整内容请下载</Typography.Text>}
          </div>
        );
      case 'ppt':
        return (
          <Result
            status="info"
            title="PPT 暂不支持离线预览"
            subTitle="请下载后使用本地 Office 查看"
            extra={<Button type="primary" icon={<DownloadOutlined />} onClick={() => void handleDownload()}>下载</Button>}
          />
        );
      case 'text':
        return <pre className="text-preview">{text}</pre>;
      case 'video':
        return (
          <div className="preview-container">
            <video src={url} controls autoPlay style={{ maxWidth: '100%' }} />
          </div>
        );
      case 'audio':
        return (
          <div className="preview-container" style={{ flexDirection: 'column', gap: 12 }}>
            <Typography.Text style={{ color: '#fff' }}>{file.name}</Typography.Text>
            <audio src={url} controls autoPlay style={{ width: '80%' }} />
          </div>
        );
      default:
        return (
          <Result
            status="info"
            title="该文件类型不支持在线预览"
            subTitle={`${file.name}（${formatSize(file.size)}）`}
            extra={<Button type="primary" icon={<DownloadOutlined />} onClick={() => void handleDownload()}>下载</Button>}
          />
        );
    }
  };

  const handleDownload = async (): Promise<void> => {
    if (!file) return;
    try {
      const res = await filesApi.download(file.id);
      window.open(res.url, '_blank');
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <Modal
      open={!!file}
      onCancel={onClose}
      footer={null}
      width={920}
      destroyOnHidden
      title={
        <Space>
          <span>{file.name}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {formatSize(file.size)}
          </Typography.Text>
          <Button size="small" type="link" icon={<DownloadOutlined />} onClick={() => void handleDownload()}>
            下载
          </Button>
        </Space>
      }
    >
      {renderBody()}
    </Modal>
  );
}
