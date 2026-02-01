import React, { useEffect, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import PageHeader from '../components/layout/PageHeader';
import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Checkbox } from '../components/ui/checkbox';
import { Button } from '../components/ui/button';
import ReactMarkdown from 'react-markdown';
import { Table, TableHead, TableBody, TableRow, TableCell, TableHeaderCell } from '../components/ui/table';

const schema = z.object({
  name: z.string().min(1),
  content: z.string().min(1),
  description: z.string().optional(),
  active: z.boolean().default(true)
});

const TemplatesPage = () => {
  const queryClient = useQueryClient();
  const { data: templates = [] } = useQuery({ queryKey: ['templates'], queryFn: () => api.get('/api/templates') });
  const { data: availableVariables = [] } = useQuery({ 
    queryKey: ['available-variables'], 
    queryFn: () => api.get('/api/templates/available-variables') 
  });
  const [active, setActive] = useState(null);

  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: { name: '', content: '', description: '', active: true }
  });

  useEffect(() => {
    if (active) {
      form.reset({
        name: active.name,
        content: active.content,
        description: active.description || '',
        active: active.active ?? true
      });
    }
  }, [active, form]);

  const saveTemplate = useMutation({
    mutationFn: (payload) =>
      active ? api.put(`/api/templates/${active.id}`, payload) : api.post('/api/templates', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates'] });
      setActive(null);
      form.reset();
    }
  });

  const deleteTemplate = useMutation({
    mutationFn: (id) => api.delete(`/api/templates/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['templates'] })
  });

  const onSubmit = (values) => {
    const payload = {
      name: values.name,
      content: values.content,
      description: values.description,
      active: values.active
    };
    saveTemplate.mutate(payload);
  };

  const insertVariable = (varName) => {
    const currentContent = form.getValues('content');
    form.setValue('content', `${currentContent}{{${varName}}}`);
  };

  return (
    <div className="space-y-8">
      <PageHeader title="Templates" subtitle="Compose WhatsApp-ready messages with markdown and variables." />

      <section className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <Card>
          <CardHeader>
            <CardTitle>{active ? 'Edit Template' : 'Create Template'}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Template name</label>
                <Input {...form.register('name')} placeholder="Breaking News Template" />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Content (WhatsApp markdown supported)</label>
                <Textarea {...form.register('content')} placeholder="*{{title}}*&#10;{{link}}" rows={6} />
              </div>
              
              {/* Available Variables Section */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Available Variables (click to insert)</label>
                <div className="flex flex-wrap gap-2 rounded-lg border border-ink/10 bg-white/50 p-3">
                  {availableVariables.length > 0 ? (
                    availableVariables.map((variable) => (
                      <button
                        key={variable.name}
                        type="button"
                        onClick={() => insertVariable(variable.name)}
                        className="rounded-full bg-sky-100 px-3 py-1 text-xs font-medium text-sky-700 hover:bg-sky-200 transition-colors"
                        title={variable.description}
                      >
                        {`{{${variable.name}}}`}
                      </button>
                    ))
                  ) : (
                    <p className="text-sm text-ink/50">
                      No feed items yet. Add a feed and fetch items to see available variables.
                    </p>
                  )}
                </div>
              </div>
              
              <div className="space-y-2">
                <label className="text-sm font-medium">Description (optional)</label>
                <Input {...form.register('description')} placeholder="Template for daily news updates" />
              </div>
              <Controller
                control={form.control}
                name="active"
                render={({ field }) => (
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <Checkbox checked={field.value} onChange={(e) => field.onChange(e.target.checked)} />
                    Active
                  </label>
                )}
              />
              <div className="flex gap-2">
                <Button type="submit" disabled={saveTemplate.isPending}>
                  {active ? 'Update Template' : 'Save Template'}
                </Button>
                {active && (
                  <Button type="button" variant="outline" onClick={() => setActive(null)}>
                    Clear
                  </Button>
                )}
              </div>
            </form>
            <div className="rounded-2xl border border-ink/10 bg-white/80 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink/50">Preview</p>
              <div className="prose prose-sm mt-3 max-w-none text-ink">
                <ReactMarkdown>{form.watch('content') || 'Start typing to preview.'}</ReactMarkdown>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Existing Templates</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Name</TableHeaderCell>
                  <TableHeaderCell>Active</TableHeaderCell>
                  <TableHeaderCell>Actions</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {templates.map((template) => (
                  <TableRow key={template.id}>
                    <TableCell>{template.name}</TableCell>
                    <TableCell>{template.active ? 'Yes' : 'No'}</TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={() => setActive(template)}>
                          Edit
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => deleteTemplate.mutate(template.id)}>
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {templates.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-ink/50">
                      No templates created.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </section>
    </div>
  );
};

export default TemplatesPage;
