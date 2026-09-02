// 文件搜索页（元数据检索）
import { useEffect, useMemo, useState } from 'react';
import { Input, Pagination, Space, Card, message } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { searchApi } from '../api';
import type { FileItem } from '../api/types';
import FileTable from '../components/FileTable';
import FilePreview from '../components/FilePreview';

export default function SearchPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const initialQ = params.get('q') || '';
  const [q, setQ] = useState(initialQ);
  const [items, setItems] = useState<FileItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null);

  useEffect(() => {
    const keyword = params.get('q') || '';
    setQ(keyword);
    if (!keyword) {
      setItems([]);
      setTotal(0);
      return;
    }
    setLoading(true);
    searchApi
      .search({ q: keyword, page, pageSize })
      .then((res) => {
        setItems(res.items);
        setTotal(res.total);
      })
      .catch((e) => message.error((e as Error).message))
      .finally(() => setLoading(false));
  }, [params, page, pageSize]);

  const showQ = useMemo(() => q || initialQ, [q, initialQ]);

  return (
    <div style={{ background: '#fff', borderRadius: 8, padding: 16 }}>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Input
          size="large"
          prefix={<SearchOutlined />}
          placeholder="输入文件名关键词搜索"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onPressEnter={() => {
            if (q.trim()) {
              navigate(`/search?q=${encodeURIComponent(q.trim())}`);
              setPage(1);
            }
          }}
          allowClear
        />
        <Card size="small" title={`搜索结果：${total} 条${showQ ? `（关键词：${showQ}）` : ''}`}>
          <FileTable
            items={items}
            loading={loading}
            selectable={false}
            onPreview={(item) => setPreviewFile(item)}
            onOpenDir={(item) => navigate(`/?dirId=${item.id}`)}
            showOwner
            emptyText={showQ ? '未找到匹配的文件' : '请输入关键词搜索'}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
            <Pagination
              current={page}
              pageSize={pageSize}
              total={total}
              showSizeChanger={false}
              onChange={setPage}
            />
          </div>
        </Card>
      </Space>
      <FilePreview file={previewFile} onClose={() => setPreviewFile(null)} />
    </div>
  );
}
