.PHONY: pr-merge test build

build:
	npm run build

test:
	npm test

# 等 CI 绿再 squash（禁裸 gh pr merge；与私有仓同闸）
pr-merge:
	bash scripts/pr-merge.sh $(PR)
