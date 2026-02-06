UPDATE templates
SET content = replace(content, '↔', '<->')
WHERE content LIKE '%↔%';

UPDATE templates
SET content = replace(content, '←', '<-')
WHERE content LIKE '%←%';

UPDATE templates
SET content = replace(content, '⬅', '<-')
WHERE content LIKE '%⬅%';

UPDATE templates
SET content = replace(content, '→', '->')
WHERE content LIKE '%→%';

UPDATE templates
SET content = replace(content, '➡', '->')
WHERE content LIKE '%➡%';

UPDATE templates
SET content = replace(content, '➔', '->')
WHERE content LIKE '%➔%';

UPDATE templates
SET content = replace(content, '➜', '->')
WHERE content LIKE '%➜%';

UPDATE templates
SET content = replace(content, '➝', '->')
WHERE content LIKE '%➝%';

UPDATE templates
SET content = replace(content, '➞', '->')
WHERE content LIKE '%➞%';

UPDATE templates
SET content = replace(content, '➠', '->')
WHERE content LIKE '%➠%';
